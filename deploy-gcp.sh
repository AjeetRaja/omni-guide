#!/bin/bash
# deploy-gcp.sh — Automated Google Cloud Run deployment
# For hackathon bonus: Infrastructure-as-Code deployment script
# Usage: ./deploy-gcp.sh

set -euo pipefail

# ─── Config (edit these) ──────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:-your-gcp-project-id}"
REGION="${GCP_REGION:-asia-south1}"         # Mumbai — closest to India
SERVICE_NAME="omni-guide-backend"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
# ─────────────────────────────────────────────────────────

echo "🚀 Omni-Guide — Google Cloud Run Deployment"
echo "   Project: ${PROJECT_ID}"
echo "   Region:  ${REGION}"
echo ""

# 1. Authenticate (assumes gcloud is installed and authenticated)
gcloud config set project "${PROJECT_ID}"

# 2. Enable required APIs
echo "📡 Enabling Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  --quiet

# 3. Create GCS bucket for evidence audio (if not exists)
BUCKET_NAME="omni-guide-evidence-${PROJECT_ID}"
if ! gsutil ls "gs://${BUCKET_NAME}" &>/dev/null; then
  echo "🪣 Creating evidence storage bucket..."
  gsutil mb -p "${PROJECT_ID}" -l "${REGION}" "gs://${BUCKET_NAME}"
  gsutil iam ch allUsers:objectViewer "gs://${BUCKET_NAME}"  # Public read for evidence links
fi

# 4. Store secrets in Secret Manager
echo "🔐 Storing secrets..."
for SECRET_NAME in GEMINI_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER \
                   GUARDIAN_PHONE_NUMBER EMERGENCY_PHONE_POLICE; do
  if [ -n "${!SECRET_NAME:-}" ]; then
    echo -n "${!SECRET_NAME}" | gcloud secrets create "${SECRET_NAME}" \
      --data-file=- --quiet 2>/dev/null || \
    echo -n "${!SECRET_NAME}" | gcloud secrets versions add "${SECRET_NAME}" \
      --data-file=- --quiet
    echo "   ✓ ${SECRET_NAME}"
  fi
done

# 5. Build and push Docker image
echo "🐳 Building Docker image..."
docker build -t "${IMAGE_NAME}:latest" .
docker push "${IMAGE_NAME}:latest"

# 6. Deploy to Cloud Run
echo "☁️  Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_NAME}:latest" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --port 3001 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 300 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT_ID=${PROJECT_ID},GOOGLE_CLOUD_BUCKET_NAME=${BUCKET_NAME},EVIDENCE_UPLOAD_BASE_URL=https://storage.googleapis.com/${BUCKET_NAME}" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest,TWILIO_ACCOUNT_SID=TWILIO_ACCOUNT_SID:latest,TWILIO_AUTH_TOKEN=TWILIO_AUTH_TOKEN:latest,TWILIO_PHONE_NUMBER=TWILIO_PHONE_NUMBER:latest,GUARDIAN_PHONE_NUMBER=GUARDIAN_PHONE_NUMBER:latest,EMERGENCY_PHONE_POLICE=EMERGENCY_PHONE_POLICE:latest" \
  --quiet

# 7. Get the deployed URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" --format "value(status.url)")

echo ""
echo "✅ Deployment complete!"
echo "   Backend URL: ${SERVICE_URL}"
echo "   Health:      ${SERVICE_URL}/health"
echo ""
echo "📝 Update your frontend .env:"
echo "   VITE_BACKEND_URL=${SERVICE_URL}"
