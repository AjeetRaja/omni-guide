// utils/speechUtils.js

let currentUtterance = null;

/**
 * Speak text using Web Speech API.
 * Cancels any current speech to prevent queue buildup.
 */
export function speak(text, options = {}) {
  if (!window.speechSynthesis || !text?.trim()) return;

  // Cancel ongoing speech to prevent repetition queues
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate   = options.rate   ?? 1.1;   // Slightly faster for quick alerts
  utterance.pitch  = options.pitch  ?? 1.0;
  utterance.volume = options.volume ?? 1.0;
  utterance.lang   = options.lang   ?? "en-IN";

  // Prefer a female voice for the assistant
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) => v.lang.startsWith("en") && v.name.toLowerCase().includes("female")
  ) || voices.find((v) => v.lang.startsWith("en")) || null;

  if (preferred) utterance.voice = preferred;

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

/**
 * Stop any ongoing speech.
 */
export function stopSpeech() {
  window.speechSynthesis?.cancel();
}

/**
 * Start continuous speech recognition.
 * Returns a cleanup function.
 */
export function startSpeechRecognition({ onResult, onError, continuous = true }) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    onError?.("Speech recognition not supported in this browser.");
    return () => {};
  }

  const recognition = new SpeechRecognition();
  recognition.continuous      = continuous;
  recognition.interimResults  = false;
  recognition.lang            = "en-IN";
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[event.results.length - 1][0].transcript.trim();
    if (transcript) onResult?.(transcript);
  };

  recognition.onerror = (e) => {
    // 'no-speech' and 'aborted' are non-fatal
    if (e.error !== "no-speech" && e.error !== "aborted") {
      onError?.(e.error);
    }
  };

  recognition.onend = () => {
    // Auto-restart if continuous mode
    if (continuous) {
      try { recognition.start(); } catch {}
    }
  };

  try {
    recognition.start();
  } catch (err) {
    onError?.(err.message);
  }

  return () => {
    recognition.continuous = false;
    recognition.stop();
  };
}
