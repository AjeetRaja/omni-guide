// server.js
// Omni-Guide AI Assistant — Main Backend Server

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const { analyzeFrame, analyzeVocalThreat } = require("./services/geminiService");
const { triggerFullSOS } = require("./services/twilioService");
const { saveEvidenceAudio, serveLocalEvidence } = require("./services/evidenceService");

// ─── App Setup ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:5173",
];

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
  // Increase ping timeout to prevent premature disconnections
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
serveLocalEvidence(app);

// Multer for evidence audio uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// ─── Per-Socket Rate Limiting ──────────────────────────────────────────────
// Prevents flooding: tracks last processed time per socket
const socketLastProcessed = new Map();
const MIN_FRAME_INTERVAL_MS = 500; // Max 2 frames/sec per socket

// ─── Health Check ──────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "omni-guide-backend",
    timestamp: new Date().toISOString(),
    gemini: !!process.env.GEMINI_API_KEY,
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
  });
});

// ─── REST: SOS Trigger ────────────────────────────────────────────────────
app.post("/api/sos", async (req, res) => {
  const { userName, location, evidenceUrl, threatType } = req.body;

  if (!userName) {
    return res.status(400).json({ error: "userName is required" });
  }

  try {
    const result = await triggerFullSOS({ userName, location, evidenceUrl, threatType });
    res.json(result);
  } catch (err) {
    console.error("[SOS Route] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── REST: Upload Evidence Audio ──────────────────────────────────────────
app.post("/api/evidence/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  const { userId } = req.body;

  try {
    const result = await saveEvidenceAudio(req.file.buffer, userId || "anonymous");
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[Evidence Upload] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── REST: Vocal Threat Detection ─────────────────────────────────────────
app.post("/api/analyze/vocal", async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) {
    return res.status(400).json({ error: "transcript is required" });
  }

  try {
    const result = await analyzeVocalThreat(transcript);
    res.json(result);
  } catch (err) {
    console.error("[Vocal Analysis] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Socket.IO: Real-time Frame Processing ────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socketLastProcessed.set(socket.id, 0);

  // ── Frame Analysis Event ──────────────────────────────────────────────
  // FIX: Use async handler with proper error boundaries to prevent "Thinking..." hang
  socket.on("analyze_frame", async (payload) => {
    const { imageBase64, mode, userQuery } = payload || {};

    // Input validation
    if (!imageBase64) {
      return socket.emit("analysis_error", { error: "No image data provided" });
    }

    // Rate limiting: drop frames if too frequent
    const now = Date.now();
    const lastTime = socketLastProcessed.get(socket.id) || 0;
    if (now - lastTime < MIN_FRAME_INTERVAL_MS) {
      return; // Silently drop — prevents queue buildup
    }
    socketLastProcessed.set(socket.id, now);

    // Signal to client that processing has started
    socket.emit("analysis_start");

    try {
      // Strip data URL prefix if present
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

      const startTime = Date.now();
      const { text, raw } = await analyzeFrame(cleanBase64, mode || "navigation", userQuery || "");
      const latency = Date.now() - startTime;

      console.log(`[Gemini] ${mode} | ${latency}ms | ${text?.substring(0, 60)}`);

      // Emit result back to the specific client
      socket.emit("analysis_result", {
        text,
        raw,
        mode,
        latency,
        timestamp: Date.now(),
      });

      // If danger mode detects critical threat, also broadcast to trigger SOS flow
      if (mode === "danger" && raw?.threat_detected && raw?.requires_sos) {
        socket.emit("threat_detected", {
          threatType: raw.threat_type,
          threatLevel: raw.threat_level,
          message: raw.alert_message,
        });
      }
    } catch (err) {
      console.error(`[Socket] Frame analysis error for ${socket.id}:`, err.message);
      // Emit error instead of hanging — this is the "Thinking..." fix
      socket.emit("analysis_error", {
        error: "Analysis failed. Please try again.",
        detail: err.message,
      });
    }
  });

  // ── SOS Trigger via Socket ────────────────────────────────────────────
  socket.on("trigger_sos", async (payload) => {
    const { userName, location, evidenceUrl, threatType } = payload || {};

    console.log(`[Socket] SOS triggered by ${socket.id} for user: ${userName}`);
    socket.emit("sos_status", { status: "initiating", message: "Contacting emergency services..." });

    try {
      const result = await triggerFullSOS({ userName, location, evidenceUrl, threatType });
      socket.emit("sos_status", {
        status: result.success ? "sent" : "partial_failure",
        message: result.success ? "SOS sent to police and guardian." : "Some SOS messages failed.",
        results: result.results,
      });
    } catch (err) {
      console.error(`[Socket] SOS error for ${socket.id}:`, err.message);
      socket.emit("sos_status", { status: "error", message: "SOS failed. Call 100 manually." });
    }
  });

  // ── Cleanup on disconnect ──────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
    socketLastProcessed.delete(socket.id);
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║        OMNI-GUIDE BACKEND  v1.0.0            ║
║   The Digital Eye — Serving on port ${PORT}    ║
╠══════════════════════════════════════════════╣
║  Gemini: ${process.env.GEMINI_API_KEY ? "✓ Configured" : "✗ Missing API Key"}                   ║
║  Twilio: ${process.env.TWILIO_ACCOUNT_SID ? "✓ Configured" : "✗ Missing Credentials"}                ║
║  GCS:    ${process.env.GOOGLE_CLOUD_BUCKET_NAME ? "✓ Configured" : "✗ Using local fallback"}              ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = { app, server }; // For testing
