# 👁️ Omni-Guide — The Digital Eye

**A real-time multimodal AI assistant for the visually impaired.**  
Built for the Google Gemini Live Agent Challenge.

Omni-Guide acts as a "Digital Eye" — combining camera vision, voice input, and AI to provide spatial awareness, situational reading, and emergency protection for users with visual impairments.

---

## ✨ Features

### 🧭 Navigation Mode (Clock System)
- Identifies objects and describes their position using **clock-face orientation** (e.g., "Door at 11 o'clock")
- Provides **directional movement advice**: "Move left to avoid chair at 3 o'clock"
- Concise responses under 12 words — no information overload

### 🛒 Grocery Mode
- OCR-style product identification: **name, brand, price, expiry date**
- Works on store shelves, product labels, price tags

### 🚌 Transport Mode
- Identifies **bus numbers, platform signs, route displays**
- Locates **empty seats** within vehicles

### 🛡️ Women's Safety Shield
- **Visual threat detection**: weapons, aggression, suspicious behavior
- **Vocal threat detection**: death threats, distress calls, "help me" screams
- **5-minute rolling audio buffer** — evidence automatically captured
- **Automated SOS**: Police (100) + Guardian via Twilio call + SMS
- Sends **user name, live GPS location, and evidence audio link**

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite |
| Real-time | Socket.IO |
| Backend | Node.js + Express |
| AI Engine | Gemini 1.5 Flash (Vision + Text) |
| Emergency | Twilio (Voice + SMS) |
| Location | Browser Geolocation API + Google Maps links |
| Cloud | Google Cloud Run + GCS |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- Gemini API key (Google AI Studio)
- Twilio account (for SOS)
- (Optional) Google Cloud project

### 1. Clone & Configure

```bash
git clone https://github.com/your-username/omni-guide.git
cd omni-guide

# Backend config
cp backend/.env.example backend/.env
# Edit backend/.env with your API keys

# Frontend config  
cp frontend/.env.example frontend/.env
```

### 2. Install Dependencies

```bash
# Backend
cd backend && npm install

# Frontend (new terminal)
cd frontend && npm install
```

### 3. Run Locally

```bash
# Terminal 1 — Backend
cd backend && npm run dev

# Terminal 2 — Frontend
cd frontend && npm run dev
```

Open `http://localhost:5173` in your browser.

---

## ☁️ Google Cloud Deployment

### Automated (IaC)
```bash
# Set environment variables
export GCP_PROJECT_ID="your-project-id"
export GEMINI_API_KEY="your-key"
export TWILIO_ACCOUNT_SID="your-sid"
# ... (see deploy-gcp.sh for full list)

chmod +x deploy-gcp.sh
./deploy-gcp.sh
```

### Manual (Cloud Run via Console)
1. Build Docker image: `docker build -t gcr.io/PROJECT_ID/omni-guide-backend .`
2. Push: `docker push gcr.io/PROJECT_ID/omni-guide-backend`
3. Deploy via Cloud Run console with env vars from `.env.example`

---

## 📁 Project Structure

```
omni-guide/
├── backend/
│   ├── server.js                 # Express + Socket.IO server
│   ├── services/
│   │   ├── geminiService.js      # Gemini 1.5 Flash multimodal AI
│   │   ├── twilioService.js      # SOS calls + SMS
│   │   └── evidenceService.js    # Audio evidence → GCS
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx               # Main UI
│   │   ├── hooks/
│   │   │   ├── useSocket.js      # Real-time Socket.IO
│   │   │   ├── useCamera.js      # Camera capture
│   │   │   └── useAudioBuffer.js # Rolling 5-min evidence buffer
│   │   ├── utils/
│   │   │   └── speechUtils.js    # TTS + Speech recognition
│   │   └── index.css
│   └── package.json
├── Dockerfile
├── deploy-gcp.sh
└── README.md
```

---

## 🔑 Key Technical Decisions

### Socket.IO "Thinking..." Fix
The hang was caused by unhandled Promise rejections in the frame handler. Fixed by:
1. Wrapping `analyzeFrame()` in `try/catch` and always emitting `analysis_error` on failure
2. Rate limiting with `MIN_FRAME_INTERVAL_MS = 500ms` to prevent queue buildup
3. Emitting `analysis_start` so client shows loading state immediately

### Audio Buffer Architecture
Rather than one huge recording that could crash browsers, we use:
- **10 × 30-second chunks** (rolling, max 5 minutes total)
- `setInterval` seals each chunk; `MediaRecorder.ondataavailable` every 250ms fills them
- `getEvidenceBlob()` concatenates all chunks into one WebM Blob on demand
- Result: ~2–5 MB for 5 minutes of audio, never crashes

### Gemini Prompt Engineering
- Separate system prompts per mode with strict word limits
- Danger mode returns structured JSON for programmatic SOS triggering
- Temperature 0.1 for threat detection (deterministic), 0.3 for navigation (varied)

---

## 🔒 Security

- `.env` is gitignored — API keys never committed
- Evidence files stored in GCS with controlled access
- Non-root Docker user
- Input validation on all Socket.IO events

---

## 📄 License
MIT
