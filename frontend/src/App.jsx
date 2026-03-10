// App.jsx — Omni-Guide Digital Eye
import { useState, useEffect, useRef, useCallback } from "react";
import { useSocket }      from "./hooks/useSocket";
import { useCamera }      from "./hooks/useCamera";
import { useAudioBuffer } from "./hooks/useAudioBuffer";
import { speak, stopSpeech, startSpeechRecognition } from "./utils/speechUtils";

// ─── Mode Config ──────────────────────────────────────────────────────────
const MODES = [
  { id: "navigation", label: "Navigate",  icon: "⬡", color: "#00FFD1" },
  { id: "grocery",    label: "Grocery",   icon: "⬡", color: "#FFD100" },
  { id: "transport",  label: "Transport", icon: "⬡", color: "#00AAFF" },
  { id: "danger",     label: "Shield",    icon: "⬡", color: "#FF4444" },
];

const FRAME_INTERVAL_MS = 1500; // Send a frame every 1.5s in auto mode

export default function App() {
  // ── State ──────────────────────────────────────────────────────────────
  const [mode,          setMode]          = useState("navigation");
  const [response,      setResponse]      = useState("Tap Start to activate your Digital Eye");
  const [isProcessing,  setIsProcessing]  = useState(false);
  const [threatAlert,   setThreatAlert]   = useState(null); // { type, level, message }
  const [sosState,      setSosState]      = useState("idle"); // idle | arming | active | sent
  const [userName,      setUserName]      = useState("User");
  const [showSettings,  setShowSettings]  = useState(false);
  const [guardianPhone, setGuardianPhone] = useState("");
  const [autoMode,      setAutoMode]      = useState(false);
  const [listening,     setListening]     = useState(false);
  const [userQuery,     setUserQuery]     = useState("");
  const [geoLocation,   setGeoLocation]   = useState(null);

  // ── Refs ───────────────────────────────────────────────────────────────
  const frameTimerRef    = useRef(null);
  const speechStopRef    = useRef(null);
  const sosHoldTimerRef  = useRef(null);
  const responseCountRef = useRef(0);

  // ── Hooks ──────────────────────────────────────────────────────────────
  const { connected, emit, on, off } = useSocket();
  const { videoRef, canvasRef, isActive: camActive, error: camError,
          startCamera, stopCamera, flipCamera, captureFrame } = useCamera();
  const { isRecording, bufferDuration, error: audioError,
          startRecording, stopRecording, uploadEvidence } = useAudioBuffer();

  // ── Geolocation ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => setGeoLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => console.warn("[Geo]", err.message),
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // ── Socket Listeners ───────────────────────────────────────────────────
  useEffect(() => {
    const removeResult = on("analysis_result", ({ text, raw, latency }) => {
      setIsProcessing(false);

      if (!text) return;

      // Deduplicate: ignore if identical to last response
      const clean = text.trim();
      setResponse(clean);
      speak(clean);

      // Danger mode: check if SOS needed
      if (raw?.threat_detected && raw?.requires_sos) {
        setThreatAlert({ type: raw.threat_type, level: raw.threat_level, message: raw.alert_message });
      }
    });

    const removeError = on("analysis_error", ({ error }) => {
      setIsProcessing(false);
      console.error("[App] Analysis error:", error);
      // Don't speak errors to avoid disrupting navigation
    });

    const removeThreat = on("threat_detected", (threat) => {
      setThreatAlert(threat);
      speak(`Warning! ${threat.message || "Threat detected. Activating shield."}`);
      // Auto-trigger SOS countdown for critical threats
      if (threat.threatLevel === "critical") {
        beginSOSCountdown();
      }
    });

    const removeSosStatus = on("sos_status", ({ status, message }) => {
      if (status === "sent") {
        setSosState("sent");
        speak("SOS sent. Help is coming.");
      } else if (status === "error") {
        setSosState("idle");
        speak("SOS failed. Call one hundred manually.");
      }
    });

    return () => {
      removeResult?.();
      removeError?.();
      removeThreat?.();
      removeSosStatus?.();
    };
  }, [on]);

  // ── Send Frame to Backend ──────────────────────────────────────────────
  const sendFrame = useCallback((query = "") => {
    if (!connected || !camActive || isProcessing) return;

    const frame = captureFrame();
    if (!frame) return;

    setIsProcessing(true);
    setUserQuery(query);

    emit("analyze_frame", {
      imageBase64: frame,
      mode,
      userQuery: query,
    });
  }, [connected, camActive, isProcessing, captureFrame, emit, mode]);

  // ── Auto Mode: Continuous Analysis ────────────────────────────────────
  useEffect(() => {
    if (autoMode && camActive) {
      frameTimerRef.current = setInterval(() => sendFrame(""), FRAME_INTERVAL_MS);
    } else {
      clearInterval(frameTimerRef.current);
    }
    return () => clearInterval(frameTimerRef.current);
  }, [autoMode, camActive, sendFrame]);

  // ── Voice Recognition ──────────────────────────────────────────────────
  const toggleListening = useCallback(() => {
    if (listening) {
      speechStopRef.current?.();
      setListening(false);
      speak("Voice off.");
    } else {
      speak("Listening.");
      const stop = startSpeechRecognition({
        onResult: (transcript) => {
          console.log("[Voice]", transcript);
          setUserQuery(transcript);
          sendFrame(transcript);
          // Also check vocal threats
          fetch("/api/analyze/vocal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transcript }),
          })
            .then((r) => r.json())
            .then((data) => {
              if (data.isThreat && (data.severity === "high" || data.severity === "critical")) {
                setThreatAlert({ type: data.threatType, level: data.severity, message: "Vocal threat detected!" });
                if (data.severity === "critical") beginSOSCountdown();
              }
            })
            .catch(() => {});
        },
        onError: (err) => console.warn("[Voice Error]", err),
      });
      speechStopRef.current = stop;
      setListening(true);
    }
  }, [listening, sendFrame]);

  // ── Start Session ──────────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    await startCamera("environment");
    await startRecording();
    setAutoMode(true);
    speak("Digital Eye activated. Scanning environment.");
  }, [startCamera, startRecording]);

  // ── Stop Session ───────────────────────────────────────────────────────
  const stopSession = useCallback(() => {
    setAutoMode(false);
    stopCamera();
    stopRecording();
    speechStopRef.current?.();
    setListening(false);
    speak("Digital Eye deactivated.");
  }, [stopCamera, stopRecording]);

  // ── SOS: Hold 3 seconds to trigger ────────────────────────────────────
  const beginSOSCountdown = useCallback(() => {
    setSosState("arming");
    speak("SOS activating. Uploading evidence.");
    executeSOSProtocol();
  }, []);

  const handleSOSHoldStart = useCallback(() => {
    sosHoldTimerRef.current = setTimeout(() => beginSOSCountdown(), 3000);
  }, [beginSOSCountdown]);

  const handleSOSHoldEnd = useCallback(() => {
    clearTimeout(sosHoldTimerRef.current);
    if (sosState === "arming") setSosState("idle");
  }, [sosState]);

  const executeSOSProtocol = useCallback(async () => {
    setSosState("active");
    speak("Uploading evidence and contacting emergency services.");

    // Upload evidence audio
    const evidenceUrl = await uploadEvidence(userName);

    // Trigger SOS via socket
    emit("trigger_sos", {
      userName,
      location: geoLocation,
      evidenceUrl: evidenceUrl || "Evidence uploading...",
      threatType: threatAlert?.type || "Emergency",
    });
  }, [userName, geoLocation, uploadEvidence, emit, threatAlert]);

  // ── Mode Switching ─────────────────────────────────────────────────────
  const switchMode = useCallback((newMode) => {
    setMode(newMode);
    const m = MODES.find((m) => m.id === newMode);
    speak(`${m?.label} mode.`);
  }, []);

  const activeMode = MODES.find((m) => m.id === mode);
  const sessionActive = camActive;

  return (
    <div className="app">
      {/* ── Threat Overlay ──────────────────────────────────────────── */}
      {threatAlert && (
        <div className="threat-overlay" onClick={() => setThreatAlert(null)}>
          <div className="threat-box">
            <div className="threat-icon">⚠</div>
            <div className="threat-type">{threatAlert.type?.replace(/_/g, " ").toUpperCase()}</div>
            <div className="threat-msg">{threatAlert.message}</div>
            <button className="sos-now-btn" onClick={executeSOSProtocol}>
              SEND SOS NOW
            </button>
            <div className="threat-dismiss">Tap anywhere to dismiss</div>
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="header">
        <div className="brand">
          <div className="eye-logo">
            <svg viewBox="0 0 60 30" width="56" height="28" fill="none">
              <path d="M2 15 Q30 2 58 15 Q30 28 2 15Z" stroke="#00FFD1" strokeWidth="1.5" fill="none"/>
              <circle cx="30" cy="15" r="7" stroke="#00FFD1" strokeWidth="1.5" fill="none"/>
              <circle cx="30" cy="15" r="3" fill="#00FFD1"/>
              <circle cx="28" cy="13" r="1" fill="white" opacity="0.8"/>
            </svg>
          </div>
          <div>
            <div className="brand-name">OMNI-GUIDE</div>
            <div className="brand-sub">Digital Eye</div>
          </div>
        </div>

        <div className="header-right">
          <div className={`conn-badge ${connected ? "conn-on" : "conn-off"}`}>
            {connected ? "●" : "○"} {connected ? "LIVE" : "OFFLINE"}
          </div>
          {isRecording && (
            <div className="rec-badge">
              ● REC {bufferDuration > 0 && `${Math.round(bufferDuration)}s`}
            </div>
          )}
          <button className="icon-btn" onClick={() => setShowSettings(!showSettings)} aria-label="Settings">
            ⚙
          </button>
        </div>
      </header>

      {/* ── Settings Panel ─────────────────────────────────────────── */}
      {showSettings && (
        <div className="settings-panel">
          <div className="settings-title">Settings</div>
          <div className="setting-row">
            <label>Your Name</label>
            <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Enter name..." />
          </div>
          <div className="setting-row">
            <label>Guardian Phone</label>
            <input value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} placeholder="+91..." />
          </div>
          <button className="settings-close" onClick={() => setShowSettings(false)}>Done</button>
        </div>
      )}

      {/* ── Camera View ────────────────────────────────────────────── */}
      <div className="camera-container">
        <video ref={videoRef} className="camera-feed" autoPlay playsInline muted />
        <canvas ref={canvasRef} style={{ display: "none" }} />

        {/* Clock overlay */}
        <div className="clock-overlay">
          {[12,1,2,3,4,5,6,7,8,9,10,11].map((h) => {
            const angle = (h / 12) * 360 - 90;
            const r = 44;
            const x = 50 + r * Math.cos((angle * Math.PI) / 180);
            const y = 50 + r * Math.sin((angle * Math.PI) / 180);
            return (
              <div
                key={h}
                className="clock-num"
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                {h}
              </div>
            );
          })}
          <div className="clock-center" />
        </div>

        {/* Mode badge */}
        <div className="mode-badge" style={{ color: activeMode?.color, borderColor: activeMode?.color }}>
          {activeMode?.label.toUpperCase()}
        </div>

        {/* Camera controls */}
        {sessionActive && (
          <button className="flip-btn" onClick={flipCamera} aria-label="Flip camera">↻</button>
        )}

        {/* Camera error / placeholder */}
        {!sessionActive && (
          <div className="cam-placeholder">
            <svg viewBox="0 0 60 30" width="80" height="40" fill="none">
              <path d="M2 15 Q30 2 58 15 Q30 28 2 15Z" stroke="#00FFD1" strokeWidth="1.5" fill="none" opacity="0.3"/>
              <circle cx="30" cy="15" r="7" stroke="#00FFD1" strokeWidth="1.5" fill="none" opacity="0.3"/>
              <circle cx="30" cy="15" r="3" fill="#00FFD1" opacity="0.3"/>
            </svg>
            <div>Camera inactive</div>
          </div>
        )}

        {isProcessing && <div className="scan-line" />}
      </div>

      {/* ── Response Panel ─────────────────────────────────────────── */}
      <div className="response-panel">
        {userQuery && <div className="user-query">You: "{userQuery}"</div>}
        <div className={`response-text ${isProcessing ? "processing" : ""}`}>
          {isProcessing ? (
            <span className="dots">
              <span>●</span><span>●</span><span>●</span>
            </span>
          ) : (
            response
          )}
        </div>
        {geoLocation && (
          <div className="geo-badge">
            📍 {geoLocation.lat.toFixed(4)}, {geoLocation.lng.toFixed(4)}
          </div>
        )}
      </div>

      {/* ── Mode Selector ──────────────────────────────────────────── */}
      <div className="mode-selector">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`mode-btn ${mode === m.id ? "active" : ""}`}
            style={mode === m.id ? { borderColor: m.color, color: m.color } : {}}
            onClick={() => switchMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* ── Control Bar ────────────────────────────────────────────── */}
      <div className="controls">
        {!sessionActive ? (
          <button className="btn-primary" onClick={startSession} disabled={!connected}>
            {connected ? "▶ Start Eye" : "Connecting..."}
          </button>
        ) : (
          <>
            <button className="btn-secondary" onClick={stopSession}>■ Stop</button>
            <button
              className={`btn-mic ${listening ? "active" : ""}`}
              onClick={toggleListening}
              aria-label={listening ? "Stop listening" : "Start listening"}
            >
              {listening ? "🎙 Listening..." : "🎙 Speak"}
            </button>
            <button className="btn-scan" onClick={() => sendFrame("")} disabled={isProcessing}>
              Scan Now
            </button>
          </>
        )}
      </div>

      {/* ── SOS Button ─────────────────────────────────────────────── */}
      <div className="sos-section">
        {sosState === "sent" ? (
          <div className="sos-sent">✓ SOS SENT — Help is coming</div>
        ) : (
          <button
            className={`sos-btn ${sosState !== "idle" ? "sos-active" : ""}`}
            onMouseDown={handleSOSHoldStart}
            onMouseUp={handleSOSHoldEnd}
            onTouchStart={handleSOSHoldStart}
            onTouchEnd={handleSOSHoldEnd}
            aria-label="Hold 3 seconds for emergency SOS"
          >
            {sosState === "arming" ? "HOLD..." : sosState === "active" ? "SENDING..." : "SOS"}
            <div className="sos-hint">Hold 3s for emergency</div>
          </button>
        )}
      </div>

      {/* ── Error display ──────────────────────────────────────────── */}
      {(camError || audioError) && (
        <div className="error-bar">{camError || audioError}</div>
      )}
    </div>
  );
}
