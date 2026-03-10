// services/evidenceService.js
// Handles saving 5-minute audio evidence to Google Cloud Storage

const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// Local fallback directory if GCS not configured
const LOCAL_EVIDENCE_DIR = path.join(__dirname, "../evidence_files");

/**
 * Save audio evidence buffer to GCS (or local fallback).
 * @param {Buffer} audioBuffer - Raw audio data (WebM/Opus)
 * @param {string} userId - User identifier
 * @returns {Promise<{url: string, filename: string}>}
 */
async function saveEvidenceAudio(audioBuffer, userId = "unknown") {
  const filename = `evidence_${userId}_${Date.now()}_${uuidv4()}.webm`;

  // Try Google Cloud Storage first
  if (process.env.GOOGLE_CLOUD_BUCKET_NAME) {
    try {
      const { Storage } = require("@google-cloud/storage");
      const storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT_ID });
      const bucket = storage.bucket(process.env.GOOGLE_CLOUD_BUCKET_NAME);
      const file = bucket.file(`evidence/${filename}`);

      await file.save(audioBuffer, {
        metadata: {
          contentType: "audio/webm",
          metadata: { userId, uploadedAt: new Date().toISOString() },
        },
      });

      // Make file publicly readable for sharing with police
      await file.makePublic();

      const url = `${process.env.EVIDENCE_UPLOAD_BASE_URL}/evidence/${filename}`;
      console.log(`[Evidence] Uploaded to GCS: ${url}`);
      return { url, filename };
    } catch (gcsErr) {
      console.error("[Evidence] GCS upload failed, falling back to local:", gcsErr.message);
    }
  }

  // Local fallback
  await fs.ensureDir(LOCAL_EVIDENCE_DIR);
  const localPath = path.join(LOCAL_EVIDENCE_DIR, filename);
  await fs.writeFile(localPath, audioBuffer);

  const url = `${process.env.EVIDENCE_UPLOAD_BASE_URL || "http://localhost:3001/evidence"}/${filename}`;
  console.log(`[Evidence] Saved locally: ${localPath}`);
  return { url, filename };
}

/**
 * Serve local evidence files (fallback route handler).
 */
function serveLocalEvidence(app) {
  app.use("/evidence", require("express").static(LOCAL_EVIDENCE_DIR));
  console.log("[Evidence] Local evidence serving enabled at /evidence");
}

module.exports = { saveEvidenceAudio, serveLocalEvidence };
