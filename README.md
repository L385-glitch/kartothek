# Studydeck

AI-flashcard generator for lecture PDFs. Upload a course PDF, let an
OpenAI-compatible LLM (your local llama.cpp) turn it into German flashcards
with real figure crops, review them with FSRS spaced repetition, and export
to Anki (.apkg) or CSV.

Single container, one port. Built for a TrueNAS SCALE homelab.

## Stack
- **Backend**: FastAPI + SQLAlchemy + SQLite, PyMuPDF (parse + figure crop),
  FSRS scheduler, Anki .apkg writer.
- **Frontend**: React + TypeScript + Vite (wizard, card-deck hub, study, import/export).
- **LLM**: any OpenAI-compatible endpoint (llama.cpp / vLLM / Ollama).

## Run locally
```bash
# backend
cd backend && pip install -r requirements.txt
STUDYDECK_DATA=/tmp/studydeck LLM_BASE_URL=http://host:9293 \
  python -m uvicorn app.main:app --port 8090

# frontend (dev)
cd frontend && npm install && npm run dev
```

## Docker (TrueNAS)
```bash
# build
docker build -t studydeck .
# run
docker run -d -p 3355:8000 \
  -v /mnt/tank/apps/studydeck/data:/data \
  -e LLM_BASE_URL=http://host.docker.internal:9293 \
  -e LLM_MODEL=your-model \
  --add-host host.docker.internal:host-gateway \
  studydeck
```
Or use `truenas.yaml` with the GitHub-Actions-built image
(`ghcr.io/l385-glitch/studydeck:main`).

## Config (env vars)
| Var | Default | Meaning |
|---|---|---|
| `STUDYDECK_DATA` | `/data` | Volume: SQLite + uploads + figures + exports |
| `LLM_BASE_URL` | `http://host.docker.internal:9293` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `Qwen3.8-27B-Q4` | Generation model |
| `LLM_MODEL_FAST` | *(empty)* | Cheaper model for quick passes |
| `PORT` | `8090` | HTTP port |
| `DEFAULT_LANGUAGE` | `de` | Card language |

> `KARTOTHEK_DATA` is still accepted as a fallback for existing deployments.

## API
`/api/health`, `/api/courses`, `/api/decks`, `/api/jobs`, `/api/cards`,
`/api/study/*` (due/review), `/api/decks/{id}/export?format=apkg|csv`.
Swagger at `/docs`.

## Layout detection
PDFs are auto-classified as **slide** (PowerPoint decks — one concept per
page) or **book** (continuous prose — chunked by section). Both are supported;
your FHNW lecture PDFs are the slide family.
