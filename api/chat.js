import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message required" });
    }

    const result = await model.generateContent(message);

    res.status(200).json({
      response: result.response.text(),
    });
  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
}
