"""Upload, analyze, and generation-job endpoints.

Flow the frontend follows:
  1. POST /api/documents        -> upload PDF, get doc_id
  2. POST /api/documents/{id}/analyze  -> LLM analysis (topics + count)
  3. POST /api/jobs             -> create deck + job with config, start
  4. GET  /api/jobs/{id}        -> poll status/progress
  5. GET  /api/decks/{id}       -> read the draft cards for review
"""
from __future__ import annotations

import json
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal, get_session_dep
from ..llm import LLMClient, LLMError
from ..models import Deck, DeckStatus, Document, Job, JobStage, JobStatus
from ..pipeline import generate as gen
from ..pipeline import jobs as job_runner
from ..pipeline import parse as parse_mod
from .schemas import AnalyzeRequest, GenerateRequest, job_out

router = APIRouter(tags=["jobs"])


@router.post("/documents", status_code=201)
async def upload_document(file: UploadFile = File(...)):
    """Store an uploaded PDF (content-hashed, deduped)."""
    settings.ensure_dirs()
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    import hashlib
    digest = hashlib.sha256(data).hexdigest()
    dest = settings.uploads_dir / f"{digest}.pdf"
    if not dest.exists():
        dest.write_bytes(data)

    # Quick parse to record page count + layout immediately.
    doc_id = uuid.uuid4().hex
    try:
        parsed = parse_mod.parse_document(doc_id, file.filename or f"{digest}.pdf", str(dest))
        parse_mod.save_parsed(parsed)
        page_count, layout = parsed.page_count, parsed.layout
    except Exception:  # noqa: BLE001
        page_count, layout = 0, "unknown"

    with SessionLocal() as s:
        existing = s.scalar(select(Document).where(Document.sha256 == digest))
        if existing:
            return {"id": existing.id, "filename": existing.filename,
                    "page_count": existing.page_count, "layout": existing.layout,
                    "duplicate": True}
        doc = Document(id=doc_id, filename=file.filename or f"{digest}.pdf",
                       sha256=digest, stored_path=str(dest),
                       page_count=page_count, layout=layout, status="parsed")
        s.add(doc)
        s.commit()
        s.refresh(doc)
        return {"id": doc.id, "filename": doc.filename, "page_count": page_count,
                "layout": layout, "duplicate": False}


@router.post("/documents/{doc_id}/analyze")
def analyze_document(doc_id: str, db: Session = Depends(get_session_dep)):
    """Run (or return cached) LLM analysis: topics + suggested card count."""
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404, "not found")
    if doc.analysis and doc.analysis != "{}":
        return {"analysis": json.loads(doc.analysis), "cached": True}

    parsed = parse_mod.load_parsed(doc_id)
    if parsed is None:
        parsed = parse_mod.parse_document(doc_id, doc.filename, doc.stored_path)
        parse_mod.save_parsed(parsed)
        db.refresh(doc)
        doc.layout = parsed.layout
        doc.page_count = parsed.page_count

    client = LLMClient()
    try:
        analysis = gen.analyze(client, parsed)
    except LLMError as e:
        raise HTTPException(502, f"LLM analysis failed: {e}")
    doc.analysis = json.dumps(analysis, ensure_ascii=False)
    db.commit()
    return {"analysis": analysis, "cached": False}


@router.post("/jobs", status_code=202)
def start_generation(body: GenerateRequest, db: Session = Depends(get_session_dep)):
    """Create a deck + generation job and start it in the background."""
    doc = db.get(Document, body.doc_id)
    if not doc:
        raise HTTPException(404, "doc not found")

    # Deck name from analysis title if available.
    config = body.config or {}
    analysis = json.loads(doc.analysis or "{}")
    name = config.get("deck_name") or analysis.get("course_title") or doc.filename
    deck = Deck(name=name.strip(), language=config.get("language", "de"),
                course_id=config.get("course_id"),
                description=config.get("description", ""),
                status=DeckStatus.DRAFT, source_doc_ids=doc.id)
    db.add(deck)
    db.flush()

    job = Job(deck_id=deck.id, doc_id=doc.id, status=JobStatus.PENDING,
              stage=JobStage.INGEST,
              config=json.dumps(config, ensure_ascii=False))
    db.add(job)
    db.commit()
    db.refresh(job)

    started = job_runner.dispatch(job.id)
    if not started:
        raise HTTPException(409, "job already running")
    return job_out(job)


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_session_dep)):
    jobs = db.scalars(select(Job).order_by(Job.created_at.desc())).all()
    return [job_out(j) for j in jobs]


@router.get("/jobs/{job_id}")
def get_job(job_id: str, db: Session = Depends(get_session_dep)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "not found")
    return job_out(job)


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str, db: Session = Depends(get_session_dep)):
    """Re-run a failed job from where it left off (stages are resumable)."""
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "not found")
    if job.status == JobStatus.RUNNING:
        raise HTTPException(409, "already running")
    job.status = JobStatus.PENDING
    job.error = ""
    db.commit()
    started = job_runner.dispatch(job.id)
    if not started:
        raise HTTPException(409, "could not start")
    return job_out(job)
