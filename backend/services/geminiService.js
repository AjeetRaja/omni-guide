// services/geminiService.js
// Handles all Gemini 1.5 Flash multimodal interactions

const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── System Prompts per Mode ───────────────────────────────────────────────
const SYSTEM_PROMPTS = {
  navigation: `You are Omni-Guide, a concise spatial assistant for visually impaired users.
RULES:
1. Describe objects using clock-face positions (12=straight ahead, 3=right, 6=behind, 9=left).
2. ALWAYS give directional advice: "Move left", "Stop", "Turn right".
3. Prioritize the most important 1-2 objects only.
4. Response MUST be under 12 words.
5. NEVER repeat the user's question back.
6. Format: "[Action] [object] at [clock position]"
Examples: "Door at 11 o'clock, move left." | "Chair at 3, step left." | "Clear path ahead."`,

  grocery: `You are Omni-Guide in Grocery Mode. Read product details from the camera.
RULES:
1. Report: product name, brand, price, expiry date.
2. Be concise: under 20 words.
3. NEVER repeat the question.
4. If multiple products visible, focus on the closest/most centered one.
5. If price/expiry not visible, say "not visible".`,

  transport: `You are Omni-Guide in Transport Mode.
RULES:
1. Identify: bus numbers, train platform signs, route displays.
2. Spot empty seats: "Empty seat at 2 o'clock" or "Row 3 has space".
3. Under 15 words.
4. NEVER repeat the question.`,

  danger: `You are Omni-Guide's Threat Detection System.
ANALYZE the image for ANY of these threats:
- Fire or smoke
- Weapons (knives, guns, sharp objects)
- Physical aggression or threatening postures
- Suspicious individuals approaching

RESPONSE FORMAT (JSON only):
{
  "threat_detected": true/false,
  "threat_level": "none" | "low" | "high" | "critical",
  "threat_type": "string or null",
  "alert_message": "Under 10 words warning or null",
  "requires_sos": true/false
}`,
};

// ─── Core Vision Analysis ──────────────────────────────────────────────────
/**
 * Analyze a camera frame with optional user voice query.
 * @param {string} base64Image - JPEG frame as base64 string
 * @param {string} mode - 'navigation' | 'grocery' | 'transport' | 'danger'
 * @param {string} userQuery - Optional spoken query from user
 * @returns {Promise<{text: string, raw: object}>}
 */
async function analyzeFrame(base64Image, mode = "navigation", userQuery = "") {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      maxOutputTokens: mode === "danger" ? 200 : 80,
      temperature: mode === "danger" ? 0.1 : 0.3, // Low temp = deterministic safety responses
    },
  });

  const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.navigation;

  // Build the prompt parts
  const promptParts = [
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image,
      },
    },
    {
      text: userQuery
        ? `${systemPrompt}\n\nUser asked: "${userQuery}"\n\nAnalyze the image and respond:`
        : `${systemPrompt}\n\nAnalyze the image and respond:`,
    },
  ];

  try {
    const result = await model.generateContent(promptParts);
    const response = result.response;
    const text = response.text().trim();

    // For danger mode, parse JSON response
    if (mode === "danger") {
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return { text: parsed.alert_message || "", raw: parsed };
        }
      } catch (parseErr) {
        console.error("[Gemini] Failed to parse danger JSON:", parseErr.message);
      }
    }

    return { text, raw: null };
  } catch (err) {
    console.error("[Gemini] analyzeFrame error:", err.message);
    throw new Error(`Gemini analysis failed: ${err.message}`);
  }
}

// ─── Vocal Threat Detection ────────────────────────────────────────────────
/**
 * Analyze transcribed audio for vocal threats.
 * @param {string} transcript - Speech-to-text transcript
 * @returns {Promise<{isThreat: boolean, threatType: string|null, severity: string}>}
 */
async function analyzeVocalThreat(transcript) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
  });

  const prompt = `You are a threat detection system. Analyze this transcript for threats.
Transcript: "${transcript}"

Respond ONLY in JSON:
{
  "isThreat": true/false,
  "threatType": "assault" | "rape_threat" | "death_threat" | "distress_call" | "weapon_mention" | null,
  "severity": "none" | "low" | "high" | "critical",
  "confidence": 0.0-1.0
}

Threat keywords include: "help me", "rape", "kill you", "I'll kill", "don't touch", screaming, "let me go", "weapon", "gun", "knife".`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error("[Gemini] analyzeVocalThreat error:", err.message);
  }

  return { isThreat: false, threatType: null, severity: "none", confidence: 0 };
}

module.exports = { analyzeFrame, analyzeVocalThreat };
