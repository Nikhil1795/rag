import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import PDFParse from "pdf-parse";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

let documents = [];

export default async function handler(req, res) {
  if (req.method === "GET") {
    await loadPDF();
    return res.json({ status: "PDF loaded" });
  }

  if (req.method === "POST") {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "No message" });

    const reply = await chatWithPDF(message);
    return res.json({ response: reply });
  }

  res.status(405).json({ error: "Method not allowed" });
}

// ---------------- HELPERS ----------------

async function loadPDF() {
  if (documents.length) return;

  const pdfPath = path.join(process.cwd(), "backend/sample.pdf");
  const buffer = fs.readFileSync(pdfPath);
  const data = await PDFParse(buffer);

  documents.push(data.text);
}

async function chatWithPDF(question) {
  const context = documents.join("\n").slice(0, 12000);

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
Answer ONLY from this PDF context.

Context:
${context}

Question:
${question}
`,
  });

  return result.text;
}
