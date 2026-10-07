# Studydeck

AI-flashcard generator for lecture PDFs. Upload a course PDF, let an
OpenAI-compatible LLM (your local llama.cpp) turn it into German flashcards
with real figure crops, review them with FSRS spaced repetition, and export
to Anki (.apkg) or CSV.

Beyond cards: your imported materials stay in a **library** (grouped by
course) so you can reuse them, and you can generate **exercises & mock exams**
from them — then submit your answers and get them **corrected & graded** by the
LLM, with the option to re-upload edited answers for a re-grade.

The UI is organised in three tabs:
- **Materialien** — upload lecture PDFs, assign them to a course, keep them as
  a reusable library.
- **Lernen** — everything you've generated (card decks + exams), grouped by
  course, ready to review, study, or take.
- **Neues erstellen** — pick your materials, then choose what to build from
  them (cards or an exam/exercise).

Single container, one port. Built for a TrueNAS SCALE homelab.

## Features
- **Materialien** — upload PDFs, assign to a course (or leave unassigned),
  keep them as a reusable library.
- **Lernen** — all generated card decks and exams, grouped by course, with
  review (FSRS), study session, Anki/CSV export, and exam-taking.
- **Neues erstellen** — a single entry point for all generation: pick
  material(s), then the job (Karten or Prüfung/Übung).
- **Prüfungen & Übungen** — generate mock exams / exercises from one or more
  materials: choose type (Prüfung/Übung), question types (MC / Kurzantwort /
  Ausführlich), difficulty, count and an optional focus.
- **Korrektur & Nachreichung** — answer an exam, submit it, and the LLM grades
  every question with per-question feedback and a total score. Edit your
  answers, add a note, and re-submit for a re-grade.

## Stack
- **Backend**: FastAPI + SQLAlchemy + SQLite, PyMuPDF (parse + figure crop),
  FSRS scheduler, Anki .apkg writer, background job runner (cards + exams).
- **Frontend**: React + TypeScript + Vite (3-tab UI — materials library,
  learning overview, create-new picker, card review, exam take/grade, study,
  import/export).
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
Cards: `/api/health`, `/api/courses`, `/api/decks`, `/api/jobs`, `/api/cards`,
`/api/study/*` (due/review), `/api/decks/{id}/export?format=apkg|csv`.

Materials: `/api/materials` (list), `/api/materials/{doc_id}/assign`,
`/api/materials/{doc_id}` (delete), `/api/documents/{doc_id}`.

Exams: `/api/exams/generate`, `/api/exams`, `/api/exams/{id}`,
`/api/exams/{id}/attempts` (submit/list), `/api/exams/{id}/attempts/{aid}`
(read), `/api/exams/{id}/attempts/{aid}/resubmit` (re-grade),
`/api/exam-jobs/{job_id}` (poll), `/api/exam-jobs/{job_id}/retry`.

Swagger at `/docs`.

## Layout detection
PDFs are auto-classified as **slide** (PowerPoint decks — one concept per
page) or **book** (continuous prose — chunked by section). Both are supported;
your FHNW lecture PDFs are the slide family.
