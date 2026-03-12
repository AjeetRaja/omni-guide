require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPTS = {
  navigate: `You are a navigation assistant for a blind person.
Look at this image and describe what you see using clock positions (12 o'clock = straight ahead).
Keep response under 12 words. Example: "Door at 11 o'clock, chair at 3 o'clock."`,

  grocery: `You are helping a blind person identify grocery items.
Read any visible text, brand names, prices, or expiry dates.
Be concise and clear. Under 20 words.`,

  transport: `You are helping a blind person with transport.
Identify bus numbers, platform signs, train info, or empty seats.
Under 15 words.`,

  shield: `You are a safety assistant for a blind person.
Detect any threats, weapons, aggressive body language, or unsafe situations.
Respond in JSON: {"threat_detected": true/false, "threat_level": "low/medium/high", 
"alert_message": "short description", "requires_sos": true/false}
If no threat: {"threat_detected": false, "threat_level": "none", 
"alert_message": "Area looks safe.", "requires_sos": false}`,
};

async function analyzeFrame({ imageBase64, mode = "navigate", userQuery = "" }) {
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

  const prompt = PROMPTS[mode] || PROMPTS.navigate;
  const fullPrompt = userQuery
    ? `${prompt}\n\nThe user asked: "${userQuery}". Answer their question specifically.`
    : prompt;

  // ✅ FIX: Strip data URL prefix if present, ensure plain string
  let cleanBase64 = imageBase64;
  if (typeof imageBase64 === "string" && imageBase64.includes(",")) {
    cleanBase64 = imageBase64.split(",")[1];
  }
  // If somehow an object was passed, try to extract the string
  if (typeof cleanBase64 === "object") {
    cleanBase64 = cleanBase64.data || cleanBase64.base64 || String(cleanBase64);
  }

  const result = await model.generateContent([
    { text: fullPrompt },
    {
      inlineData: {
        data: cleanBase64,        // ✅ plain base64 string
        mimeType: "image/jpeg",
      },
    },
  ]);

  const text = result.response.text().trim();

  // Parse JSON for shield mode
  if (mode === "shield") {
    try {
      const json = JSON.parse(text.replace(/```json|```/g, "").trim());
      return { text: json.alert_message || "Area looks safe.", raw: json };
    } catch {
      return { text, raw: null };
    }
  }

  return { text, raw: null };
}

module.exports = { analyzeFrame };