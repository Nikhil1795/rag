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
    console.log("getEmbedding: " + text.length);
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


function chunkByHeadingOrParagraph(text) {
  console.log("\n--- CHUNKING STARTED ---\n");

  // Split by double newline (paragraphs)
  const blocks = text
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(Boolean);

  const chunks = [];
  let currentHeading = "Introduction";
  let currentText = [];

  const isHeading = (line) => {
    if (line.length > 80) return false;
    if (line.endsWith(".")) return false;

    const words = line.split(" ");
    const capitalWords = words.filter(
      w => w[0] === w[0]?.toUpperCase()
    );

    return capitalWords.length / words.length > 0.6;
  };

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim());

    if (lines.length === 1 && isHeading(lines[0])) {
      if (currentText.length) {
        chunks.push({
          heading: currentHeading,
          text: currentHeading + "\n" + currentText.join(" ")
        });
      }
      currentHeading = lines[0];
      currentText = [];
    } else {
      currentText.push(block);
    }
  }

  if (currentText.length) {
    chunks.push({
      heading: currentHeading,
      text: currentHeading + "\n" + currentText.join(" ")
    });
  }

  console.log(`Total chunks created: ${chunks.length}`);
  chunks.forEach((c, i) => {
    // Print chunks 
    // console.log(`\n[CHUNK ${i + 1}] HEADING: ${c.heading}`);
    console.log(c.text.substring(0, 200));
  });

  // console.log("\n--- CHUNKING COMPLETED ---\n");

  return chunks;
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
    parser = new PDFParse({ data: dataBuffer });

    const data = await parser.getText();
    const text = data.text;

    // console.log("========== PDF CONTENT START ==========");
    // console.log(text);
    // console.log("=========== PDF CONTENT END ===========");

    console.log(`Extracted ${text.length} characters from PDF`);

    // CHUNKING
    const chunks = chunkByHeadingOrParagraph(text);

    // EMBEDDINGS
    console.log("\n--- EMBEDDING STARTED ---\n");

    for (let i = 0; i < chunks.length; i++) {
      console.log(`Embedding chunk ${i + 1}/${chunks.length}`);
      console.log("Heading:", chunks[i].heading);

      chunks[i].embedding = await getEmbedding(chunks[i].text);

      console.log(
        "Embedding vector length:",
        chunks[i].embedding.length
      );
    }

    console.log("\n--- EMBEDDING COMPLETED ---\n");

    // 🔹 STORE DOCUMENT
    documents.push({id: pdfPath,chunks});

    console.log("\n--- DOCUMENT STORED ---");
    console.log("Total documents:", documents.length);
    console.log(
      "Total chunks stored:",
      documents[0].chunks.length
    );
    console.log("------------------------");

  } finally {
    if (parser) await parser.destroy();
  }
  console.log("========= LOAD PDF END =========\n");
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
        console.log(`SIM ${sim.toFixed(3)} → ${chunk.heading}`);
        if (sim > 0.45) {
          // relevantChunks.push(chunk.text);
          relevantChunks.push({text: chunk.text, heading: chunk.heading, sim: sim});
          maxSim = Math.max(maxSim, sim);
        }
      }
    }
    relevantChunks.sort((a, b) => b.sim - a.sim);
    console.log("\n--- TOP MATCHED CHUNKS ---");
    relevantChunks.slice(0, 3).forEach((c, i) => {
      console.log(`#${i + 1} SIM ${c.sim.toFixed(3)} | ${c.heading}`);
    });
    console.log("--------------------------\n");

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
      // const context = relevantChunks.slice(0, 3).join("\n\n");
      const context = relevantChunks.slice(0, 3).map(c => c.text).join("\n\n");
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



let inp = prompt("Enter a number");
let noChar = /[^a-zA-Z\s]/g;
if(inp == 0) {
  alert(inp + "Number is 0");
} else if(inp > 0 && inp%2 == 0) {
  alert(inp + "Number is Positive Even");
} else if(inp > 0 && inp%2 !== 0) {
  alert(inp + "Number is Positive Odd");
}  else if(inp < 0) {
  alert(inp + "Number is Negative");
} else if(inp = noChar) {
   alert("Not allowed");
}
