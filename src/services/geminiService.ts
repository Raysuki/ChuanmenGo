import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const geminiModel = ai.models.generateContent.bind(ai.models, {
  model: "gemini-3-flash-preview",
});
