// hooks/useAudioBuffer.js
// Manages a rolling 5-minute audio evidence buffer without crashing the browser.
//
// DESIGN:
//  - Records audio in short CHUNKS (default 30s each).
//  - Keeps only the last N chunks to stay within the 5-minute window.
//  - When evidence is needed, concatenates all chunks into a single Blob.
//  - Uses MediaRecorder's ondataavailable for reliable, non-blocking capture.

import { useRef, useState, useCallback, useEffect } from "react";

const CHUNK_DURATION_MS = 30_000;     // Each chunk = 30 seconds
const TOTAL_WINDOW_MS   = 5 * 60_000; // Total rolling window = 5 minutes
const MAX_CHUNKS        = Math.ceil(TOTAL_WINDOW_MS / CHUNK_DURATION_MS); // = 10 chunks

export function useAudioBuffer() {
  const mediaRecorderRef  = useRef(null);
  const chunksRef         = useRef([]);   // Array of { blob, timestamp }
  const currentChunkRef   = useRef([]);   // Accumulates data for the in-progress chunk
  const streamRef         = useRef(null);
  const chunkTimerRef     = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError]             = useState(null);
  const [bufferDuration, setBufferDuration] = useState(0); // seconds stored

  // ── Update buffer duration display ──────────────────────────────────────
  const updateDuration = useCallback(() => {
    const total = Math.min(chunksRef.current.length * (CHUNK_DURATION_MS / 1000), 300);
    setBufferDuration(total);
  }, []);

  // ── Seal the current chunk and start a fresh one ─────────────────────
  const sealCurrentChunk = useCallback(() => {
    if (currentChunkRef.current.length === 0) return;

    const chunkBlob = new Blob(currentChunkRef.current, { type: "audio/webm;codecs=opus" });
    chunksRef.current.push({ blob: chunkBlob, timestamp: Date.now() });

    // Enforce rolling window: drop chunks older than 5 minutes
    while (chunksRef.current.length > MAX_CHUNKS) {
      chunksRef.current.shift();
    }

    currentChunkRef.current = [];
    updateDuration();
  }, [updateDuration]);

  // ── Start recording ───────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (isRecording) return;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      mediaRecorderRef.current = recorder;

      // Collect raw data chunks (fires every ~250ms)
      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) {
          currentChunkRef.current.push(e.data);
        }
      };

      recorder.onerror = (e) => {
        console.error("[AudioBuffer] MediaRecorder error:", e.error);
        setError("Audio recording error: " + e.error?.message);
      };

      recorder.start(250); // Emit data every 250ms for smooth rolling
      setIsRecording(true);

      // Schedule chunk sealing every CHUNK_DURATION_MS
      chunkTimerRef.current = setInterval(sealCurrentChunk, CHUNK_DURATION_MS);

      console.log("[AudioBuffer] Recording started. Max chunks:", MAX_CHUNKS);
    } catch (err) {
      console.error("[AudioBuffer] Failed to start:", err.message);
      setError(err.name === "NotAllowedError"
        ? "Microphone permission denied."
        : "Could not start audio recording: " + err.message);
    }
  }, [isRecording, sealCurrentChunk]);

  // ── Stop recording ────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (!isRecording) return;

    clearInterval(chunkTimerRef.current);
    sealCurrentChunk(); // Seal whatever's in progress

    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());

    setIsRecording(false);
    console.log("[AudioBuffer] Recording stopped. Chunks stored:", chunksRef.current.length);
  }, [isRecording, sealCurrentChunk]);

  // ── Get evidence Blob (last 5 minutes) ───────────────────────────────
  const getEvidenceBlob = useCallback(() => {
    // Seal current in-progress chunk first
    sealCurrentChunk();

    if (chunksRef.current.length === 0) {
      console.warn("[AudioBuffer] No evidence chunks available.");
      return null;
    }

    const allBlobs = chunksRef.current.map((c) => c.blob);
    const combined = new Blob(allBlobs, { type: "audio/webm;codecs=opus" });

    console.log(
      `[AudioBuffer] Evidence: ${chunksRef.current.length} chunks, ` +
      `${(combined.size / 1024).toFixed(1)} KB, ` +
      `~${chunksRef.current.length * 30}s audio`
    );
    return combined;
  }, [sealCurrentChunk]);

  // ── Upload evidence to backend ────────────────────────────────────────
  const uploadEvidence = useCallback(async (userId = "anonymous") => {
    const blob = getEvidenceBlob();
    if (!blob) return null;

    const formData = new FormData();
    formData.append("audio", blob, `evidence_${Date.now()}.webm`);
    formData.append("userId", userId);

    try {
      const res = await fetch("/api/evidence/upload", { method: "POST", body: formData });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      console.log("[AudioBuffer] Evidence uploaded:", data.url);
      return data.url;
    } catch (err) {
      console.error("[AudioBuffer] Upload error:", err.message);
      setError("Evidence upload failed: " + err.message);
      return null;
    }
  }, [getEvidenceBlob]);

  // ── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(chunkTimerRef.current);
      if (mediaRecorderRef.current?.state !== "inactive") {
        mediaRecorderRef.current?.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    isRecording,
    error,
    bufferDuration,
    startRecording,
    stopRecording,
    getEvidenceBlob,
    uploadEvidence,
  };
}
