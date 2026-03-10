// services/twilioService.js
// Handles SOS emergency calls and SMS via Twilio

const twilio = require("twilio");

let client = null;

function getClient() {
  if (!client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error("Twilio credentials not configured in .env");
    }
    client = twilio(sid, token);
  }
  return client;
}

// ─── SOS SMS ──────────────────────────────────────────────────────────────
/**
 * Send an SOS SMS to a recipient with location + evidence link.
 */
async function sendSOSSMS({ to, userName, location, evidenceUrl, threatType }) {
  const { lat, lng } = location || {};
  const mapsLink =
    lat && lng
      ? `https://maps.google.com/?q=${lat},${lng}`
      : "Location unavailable";

  const body = `🚨 OMNI-GUIDE SOS ALERT 🚨
User: ${userName || "Unknown"}
Threat: ${threatType || "Emergency"}
Location: ${mapsLink}
Evidence (5-min audio): ${evidenceUrl || "Uploading..."}
Time: ${new Date().toISOString()}
Reply HELP if you can assist.`;

  try {
    const msg = await getClient().messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`[Twilio] SMS sent to ${to}: ${msg.sid}`);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error(`[Twilio] SMS failed to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── SOS Voice Call ────────────────────────────────────────────────────────
/**
 * Initiate a TwiML voice call with spoken SOS message.
 */
async function initiateSOSCall({ to, userName, location, threatType }) {
  const { lat, lng } = location || {};
  const locationStr =
    lat && lng ? `Latitude ${lat.toFixed(4)}, Longitude ${lng.toFixed(4)}` : "location unavailable";

  // TwiML: spoken message repeated 3 times
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-IN" loop="3">
    Emergency alert from Omni Guide app.
    User ${userName || "unknown"} needs immediate help.
    Threat type: ${threatType || "emergency"}.
    Their location is: ${locationStr}.
    Please respond immediately.
  </Say>
</Response>`;

  try {
    const call = await getClient().calls.create({
      twiml,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`[Twilio] Call initiated to ${to}: ${call.sid}`);
    return { success: true, sid: call.sid };
  } catch (err) {
    console.error(`[Twilio] Call failed to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── Full SOS Protocol ─────────────────────────────────────────────────────
/**
 * Execute full SOS: call + SMS to both police and guardian.
 */
async function triggerFullSOS({ userName, location, evidenceUrl, threatType }) {
  const results = [];
  const policeNumber = process.env.EMERGENCY_PHONE_POLICE;
  const guardianNumber = process.env.GUARDIAN_PHONE_NUMBER;

  console.log("[Twilio] 🚨 Triggering full SOS protocol...");

  // Police SMS
  if (policeNumber) {
    const r = await sendSOSSMS({ to: policeNumber, userName, location, evidenceUrl, threatType });
    results.push({ target: "police", type: "sms", ...r });
  }

  // Guardian SMS
  if (guardianNumber) {
    const r = await sendSOSSMS({ to: guardianNumber, userName, location, evidenceUrl, threatType });
    results.push({ target: "guardian", type: "sms", ...r });
  }

  // Guardian Voice Call (more personal, gets attention)
  if (guardianNumber) {
    const r = await initiateSOSCall({ to: guardianNumber, userName, location, threatType });
    results.push({ target: "guardian", type: "call", ...r });
  }

  const success = results.some((r) => r.success);
  console.log(`[Twilio] SOS complete. Successful: ${success}`, results);
  return { success, results };
}

module.exports = { sendSOSSMS, initiateSOSCall, triggerFullSOS };
