# Backend image for the LLM Observability FastAPI app. Deployable to any
# Docker-friendly host (Render, Railway, Fly.io, a plain VPS) — reads
# DATABASE_URL and the provider API keys from real environment variables set
# by the host, the same way it already does locally via .env.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8010

# Most hosts (Render, Railway, ...) inject a $PORT env var and expect the app
# to bind to it — shell-form CMD so ${PORT:-8010} actually expands, falling
# back to 8010 for a plain `docker run` with no PORT set.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8010}
