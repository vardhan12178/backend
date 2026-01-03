import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

async function test() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("[ERROR] API Key missing from .env");
    return;
  }

  console.log("[INFO] API Key Found. Testing connection...");
  const genAI = new GoogleGenerativeAI(key);

  // 1. Try the new standard model for late 2025
  const modelName = "gemini-2.5-flash";

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    console.log(`[INFO] Attempting to talk to ${modelName}...`);

    const result = await model.generateContent("Hello! Are you online?");
    console.log("[SUCCESS] The API is working.");
    console.log("[INFO] Response:", result.response.text());
  } catch (error) {
    console.error(`[ERROR] Failed with ${modelName}.`);
    console.error("Error details:", error.message);

    // 2. If that fails, list available models to see what we CAN use
    if (error.message.includes("404") || error.message.includes("not found")) {
      console.log("\n[INFO] Listing available models for your key...");
      try {
        // Note: This requires a specific API call, but let's try a backup model first
        console.log("[INFO] Trying backup model: gemini-2.0-flash...");
        const backupModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const backupResult = await backupModel.generateContent("Hello!");
        console.log("[SUCCESS] Backup Success! Use 'gemini-2.0-flash' in your code.");
      } catch (e) {
        console.error("[ERROR] Backup failed too.");
      }
    }
  }
}

test();