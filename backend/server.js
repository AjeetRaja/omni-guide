// ─────────────────────────────────────────────────────────────────────────────
// backend/server.js  —  Omni-Guide Backend
// Fixes: rate-limit cooldown, gemini-2.0-flash-lite, proper error handling
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");

// ── Internal services ────────────────────────────────────────────────────────
const { analyzeFrame }   = require("./services/geminiService");
const { triggerFullSOS } = require("./services/twilioService");
const { uploadEvidence } = require("./services/evidenceService");

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS + HTTP + SOCKET.IO SETUP
// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
    ],
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 5 * 1024 * 1024, // 5MB — enough for a JPEG frame
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
  ],
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING — prevents quota burn on free tier
// ─────────────────────────────────────────────────────────────────────────────
const lastCallTime  = new Map(); // socketId → timestamp
const pendingCall   = new Map(); // socketId → boolean (is a call in-flight?)
const COOLDOWN_MS   = 3000;      // 3 seconds between Gemini calls per socket

function isRateLimited(socketId) {
  const now  = Date.now();
  const last = lastCallTime.get(socketId) || 0;
  return now - last < COOLDOWN_MS;
}

function markCalled(socketId) {
  lastCallTime.set(socketId, Date.now());
}

// ─────────────────────────────────────────────────────────────────────────────
// REST HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    gemini:    !!process.env.GEMINI_API_KEY,
    twilio:    !!process.env.TWILIO_ACCOUNT_SID,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REST: Vocal threat analysis (called from frontend)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/analyze/vocal", (req, res) => {
  const { transcript = "" } = req.body;
  if (!transcript.trim()) return res.json({ isThreat: false });

  const THREAT_WORDS = [
    "knife", "gun", "weapon", "attack", "kill", "hurt",
    "fight", "stab", "shoot", "robbery", "help me", "leave me alone",
  ];

  const lower    = transcript.toLowerCase();
  const matched  = THREAT_WORDS.filter((w) => lower.includes(w));
  const isThreat = matched.length > 0;

  res.json({
    isThreat,
    threatType: isThreat ? matched.join(", ") : null,
    severity:   isThreat ? (matched.length > 1 ? "high" : "medium") : "none",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — Main real-time logic
// ─────────────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // ── ANALYZE FRAME ──────────────────────────────────────────────────────────
  socket.on("analyze_frame", async (data) => {
    const { imageBase64, mode = "navigate", userQuery = "" } = data || {};

    // Guard: no image
    if (!imageBase64) {
      socket.emit("analysis_error", { message: "No image received." });
      return;
    }

    // Guard: already processing
    if (pendingCall.get(socket.id)) {
      // Silently drop — frontend handles UI state
      return;
    }

    // Guard: rate limit
    if (isRateLimited(socket.id)) {
      const waitSec = Math.ceil(
        (COOLDOWN_MS - (Date.now() - (lastCallTime.get(socket.id) || 0))) / 1000
      );
      socket.emit("analysis_result", {
        text: `Ready in ${waitSec} second${waitSec !== 1 ? "s" : ""}.`,
      });
      return;
    }

    // Mark in-flight
    pendingCall.set(socket.id, true);
    markCalled(socket.id);

    // Emit start so frontend shows "Thinking..."
    socket.emit("analysis_start", { mode });

    const startTime = Date.now();

    try {
      const result = await analyzeFrame({ imageBase64, mode, userQuery });
      const latency = Date.now() - startTime;

      console.log(`[Gemini] ${mode} | ${latency}ms | ${result?.text?.slice(0, 80) || "no text"}`);

      socket.emit("analysis_result", {
        text:    result.text,
        raw:     result.raw || null,
        latency,
        mode,
      });
    } catch (err) {
      const latency = Date.now() - startTime;
      console.error("[Gemini Service Error]:", err.message);

      // User-friendly error messages
      let friendlyMsg = "I couldn't analyse that. Please try again.";

      if (err.message?.includes("429") || err.message?.includes("quota")) {
        friendlyMsg = "Too many requests. Please wait a few seconds.";
      } else if (err.message?.includes("404")) {
        friendlyMsg = "AI model unavailable. Check server configuration.";
      } else if (err.message?.includes("403")) {
        friendlyMsg = "API key invalid. Check your GEMINI_API_KEY.";
      }

      socket.emit("analysis_result", { text: friendlyMsg, latency, mode });
    } finally {
      pendingCall.delete(socket.id);
    }
  });

  // ── SOS TRIGGER ────────────────────────────────────────────────────────────
  socket.on("sos_trigger", async (data) => {
    const { timestamp, gpsLat, gpsLng, audioChunks } = data || {};

    console.log(`[SOS] Triggered by ${socket.id} at ${new Date(timestamp).toISOString()}`);

    socket.emit("sos_acknowledged", { status: "processing" });

    let evidenceUrl = null;

    // Step 1: Upload audio evidence if provided
    if (audioChunks?.length) {
      try {
        evidenceUrl = await uploadEvidence(audioChunks, socket.id);
        console.log(`[SOS] Evidence uploaded: ${evidenceUrl}`);
      } catch (err) {
        console.error("[SOS] Evidence upload failed:", err.message);
      }
    }

    // Step 2: Fire Twilio (SMS + voice call)
    try {
      await triggerFullSOS({
        gpsLat:      gpsLat || "unknown",
        gpsLng:      gpsLng || "unknown",
        evidenceUrl: evidenceUrl || "No audio evidence",
        timestamp:   timestamp || Date.now(),
      });
      console.log(`[SOS] Twilio alerts sent successfully.`);
      socket.emit("sos_acknowledged", { status: "sent" });
    } catch (err) {
      console.error("[SOS] Twilio failed:", err.message);
      // SOS UI should still show even if Twilio fails
      socket.emit("sos_acknowledged", { status: "partial", error: err.message });
    }
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Client disconnected: ${socket.id} (${reason})`);
    lastCallTime.delete(socket.id);
    pendingCall.delete(socket.id);
  });

  // ── ERROR ──────────────────────────────────────────────────────────────────
  socket.on("error", (err) => {
    console.error(`[Socket] Error from ${socket.id}:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received — shutting down gracefully.");
  server.close(() => {
    console.log("[Server] HTTP server closed.");
    process.exit(0);
  });
});

process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled Rejection:", reason);
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log("─────────────────────────────────────────");
  console.log(`  🟢  Omni-Guide Backend running`);
  console.log(`  📡  Port     : ${PORT}`);
  console.log(`  🤖  Gemini   : ${process.env.GEMINI_API_KEY ? "✅ Key loaded" : "❌ MISSING KEY"}`);
  console.log(`  📞  Twilio   : ${process.env.TWILIO_ACCOUNT_SID ? "✅ Configured" : "⚠️  Not configured"}`);
  console.log(`  🌐  Frontend : ${process.env.FRONTEND_URL || "http://localhost:5173"}`);
  console.log(`  ⏱️  Cooldown : ${COOLDOWN_MS}ms per socket`);
  console.log("─────────────────────────────────────────");
});