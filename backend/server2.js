require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");
const { PDFParse } = require("pdf-parse"); // v2 import
const fs = require("fs"); // Add for file ops

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

let documents = [];

async function apiCallWithRetry(fn, maxRetries = 5) {
  // Increase to 5
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status !== 503) throw error; // Only retry 503s
      console.log(
        `503 overload on attempt ${attempt}; waiting ${Math.min(5000 * attempt, 30000)}ms...`
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(5000 * attempt, 30000))
      ); // Up to 30s
    }
  }
  throw new Error("Max retries exceeded due to overload");
}

async function getEmbedding(text) {
  try {
    console.log("Embedding:", text.substring(0, 50) + "...");
    const response = await apiCallWithRetry(() =>
      ai.models.embedContent({
        model: "gemini-embedding-001", // Valid embedding model
        contents: text,
      })
    );
    console.log("getEmbedding: " + getEmbedding + text);
    // console.log(`getEmbedding success for chunk: "${text.substring(0, 50)}..." (length: ${text.length})`);
    // console.log(`getEmbedding success: Chunk ${chunks.findIndex(c => c.text === text) + 1}/5 (length: ${text.length})`);
    // PLACEMENT: Replace existing success log with this block
    // if (process.env.NODE_ENV === 'development') {
    //   console.log(`getEmbedding success for chunk: "${text.substring(0, 50)}..." (length: ${text.length})`);
    // }
    return response.embeddings[0].values;
  } catch (error) {
    if (error.status === 429) {
      console.error("Rate limit hit—retry in 1 hour or upgrade tier");
      throw new Error(
        "Quota exceeded: Check https://aistudio.google.com/usage"
      );
    }
    console.error("Embedding error:", JSON.stringify(error, null, 2));
    throw error;
  }
}

async function loadPDF(pdfPath) {
  console.log("In loadPDF");
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }
  const dataBuffer = fs.readFileSync(pdfPath);

  let parser;
  try {
    console.log("Parsing PDF...");
    parser = new PDFParse({ data: dataBuffer }); // v2 API
    const data = await parser.getText();
    const text = data.text;
    // console.log('=== Full Extracted PDF Text ===');
    // console.log(text);
    // console.log('=== End of PDF Text ===');
    console.log(`Extracted ${text.length} chars from PDF`);

    const chunks = [];
    for (let i = 0; i < text.length; i += 500) {
      chunks.push({ text: text.slice(i, i + 500).trim() });
    }

    console.log(`Generating ${chunks.length} embeddings...`);
    for (let chunk of chunks) {
      if (chunk.text.length > 10) {
        try {
          chunk.embedding = await getEmbedding(chunk.text);
        } catch (e) {
          console.warn("Skipped chunk:", e.message);
        }
      }
    }

    documents.push({ id: pdfPath, chunks: chunks.filter((c) => c.embedding) });
    console.log(
      `Loaded ${documents[0]?.chunks.length || 0} chunks from ${pdfPath}`
    );
  } finally {
    if (parser) await parser.destroy(); // Free memory
  }
}

function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

app.get("/", (req, res) =>
  res.send("Server running! POST to /chat, GET /load-pdf.")
);

app.get("/load-pdf", async (req, res) => {
  try {
    await loadPDF("sample.pdf");
    console.log("PDF Found");
    res.json({ status: "PDF loaded successfully" });
  } catch (error) {
    console.log("No PDF Found");
    console.error("Load PDF error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  console.log("POST /chat hit");
  try {
    console.log("Query:", message);
    console.log("Query: Trying to hit");
    const queryEmbedding = await getEmbedding(message);

    let relevantChunks = [];
    let maxSim = 0;
    for (let doc of documents) {
      for (let chunk of doc.chunks) {
        const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
        if (sim > 0.7) {
          relevantChunks.push(chunk.text);
          maxSim = Math.max(maxSim, sim);
        }
      }
    }

    let responseText;
    const generateWithModel = async (modelName, prompt) => {
      return await apiCallWithRetry(async () => {
        const result = await ai.models.generateContent({
          model: modelName, // e.g., 'gemini-2.5-flash'
          contents: prompt, // String prompt
        });
        return result.text;
      });
    };

    const genModel = "gemini-2.5-flash"; // Stable model

    if (relevantChunks.length > 0) {
      const context = relevantChunks.slice(0, 3).join("\n\n");
      const prompt = `Answer based ONLY on this PDF context. If unsure, say so.\n\nContext: ${context}\n\nQuestion: ${message}\n\nAnswer:`;
      responseText = await generateWithModel(genModel, prompt);
      console.log("RAG response generated");
    } else if (maxSim > 0.5) {
      const prompt = `Answer: ${message}. Note: Partial PDF match.`;
      responseText = await generateWithModel(genModel, prompt);
      console.log("Partial PDF match");
    } else {
      const prompt = `Answer briefly: ${message}. (No PDF info found)`;
      responseText = await generateWithModel(genModel, prompt); // Single model for simplicity
      console.log("No PDF info found");
    }

    res.json({ response: responseText });
  } catch (error) {
    console.error("Full chat error:", JSON.stringify(error, null, 2));
    res.status(500).json({ error: error.message });
    console.log("No response found");
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Backend on http://localhost:${PORT}`));
