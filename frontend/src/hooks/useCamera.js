// hooks/useCamera.js
import { useRef, useState, useCallback, useEffect } from "react";

const CAPTURE_QUALITY = 0.7;   // JPEG quality (0-1)
const CAPTURE_WIDTH   = 640;   // Downscale for performance
const CAPTURE_HEIGHT  = 480;

export function useCamera() {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const streamRef   = useRef(null);

  const [isActive, setIsActive]   = useState(false);
  const [error, setError]         = useState(null);
  const [facingMode, setFacingMode] = useState("environment"); // Rear camera by default

  // ── Start camera ───────────────────────────────────────────────────────
  const startCamera = useCallback(async (mode = "environment") => {
    setError(null);
    try {
      // Stop existing stream
      streamRef.current?.getTracks().forEach((t) => t.stop());

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: CAPTURE_WIDTH },
          height: { ideal: CAPTURE_HEIGHT },
        },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setFacingMode(mode);
      setIsActive(true);
    } catch (err) {
      console.error("[Camera] Start failed:", err.message);
      setError(
        err.name === "NotAllowedError"
          ? "Camera permission denied."
          : "Could not access camera: " + err.message
      );
      setIsActive(false);
    }
  }, []);

  // ── Stop camera ────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsActive(false);
  }, []);

  // ── Flip camera (front/rear) ───────────────────────────────────────────
  const flipCamera = useCallback(() => {
    const newMode = facingMode === "environment" ? "user" : "environment";
    startCamera(newMode);
  }, [facingMode, startCamera]);

  // ── Capture current frame as base64 JPEG ──────────────────────────────
  const captureFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || video.readyState < 2) return null;

    const ctx = canvas.getContext("2d");
    canvas.width  = CAPTURE_WIDTH;
    canvas.height = CAPTURE_HEIGHT;
    ctx.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);

    // Return base64 without the data URL prefix
    const dataUrl = canvas.toDataURL("image/jpeg", CAPTURE_QUALITY);
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  return {
    videoRef,
    canvasRef,
    isActive,
    error,
    facingMode,
    startCamera,
    stopCamera,
    flipCamera,
    captureFrame,
  };
}
