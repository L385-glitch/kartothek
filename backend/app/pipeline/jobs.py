"""Resumable staged generation job.

A Job moves through fixed stages; each stage is idempotent and its
completion is recorded in job.completed_stages. On any failure or process
restart, the job resumes from the first incomplete stage — finished work
is never redone. This is what makes a multi-minute generation survive
crashes and partial LLM failures.

Stages:  ingest -> parse -> analyze -> generate -> figures -> commit -> finished

The runner is a plain function (run_job) invoked by a background thread;
all state lives in the DB so it is restart-safe.
"""
from __future__ import annotations

import json
import logging
import threading
import traceback
from pathlib import Path

from sqlalchemy import select

from ..config import settings
from ..database import SessionLocal
from ..llm import LLMClient, LLMError
from ..models import (
    Card, CardStatus, Deck, DeckStatus, Document, Job, JobStage, JobStatus,
)
from . import figures as figures_mod
from . import generate as gen
from . import parse as parse_mod

log = logging.getLogger("studydeck.job")

ALL_STAGES = [
    JobStage.INGEST, JobStage.PARSE, JobStage.ANALYZE,
    JobStage.GENERATE, JobStage.FIGURES, JobStage.COMMIT, JobStage.FINISHED,
]


def _completed(job: Job) -> set[JobStage]:
    if not job.completed_stages:
        return set()
    return {JobStage(s) for s in job.completed_stages.split(",") if s}


def _mark_done(job: Job, stage: JobStage) -> None:
    done = _completed(job)
    done.add(stage)
    job.completed_stages = ",".join(s.value for s in ALL_STAGES if s in done)


def _progress(job: Job, pct: int) -> None:
    job.progress = max(job.progress, min(100, pct))


def _store_upload(job_id: str, filename: str, src_path: str) -> Document:
    """Stage INGEST: content-hash the upload, store it, create Document row."""
    import hashlib
    src = Path(src_path)
    digest = hashlib.sha256(src.read_bytes()).hexdigest()
    # Dedupe: if this exact file is already stored, reuse it.
    with SessionLocal() as s:
        existing = s.scalar(select(Document).where(Document.sha256 == digest))
        if existing:
            doc_id = existing.id
            s.get(Job, job_id)  # ensure loaded
            j = s.get(Job, job_id)
            j.doc_id = doc_id
            s.commit()
            return existing
    settings.ensure_dirs()
    dest = settings.uploads_dir / f"{digest}.pdf"
    if not dest.exists():
        import shutil
        shutil.copyfile(src, dest)
    with SessionLocal() as s:
        doc = Document(filename=filename, sha256=digest, stored_path=str(dest),
                       status="stored")
        s.add(doc)
        s.flush()
        j = s.get(Job, job_id)
        j.doc_id = doc.id
        s.commit()
        s.expunge(doc)
        return doc


def run_job(job_id: str, upload_path: str | None = None,
            upload_filename: str | None = None) -> None:
    """Execute (or resume) a generation job to completion/failure."""
    settings.ensure_dirs()
    client = LLMClient()

    with SessionLocal() as s:
        job = s.get(Job, job_id)
        if job is None:
            log.error("job %s not found", job_id)
            return
        job.status = JobStatus.RUNNING
        s.commit()
        deck_id = job.deck_id
        config = gen.GenerationConfig.from_dict(json.loads(job.config or "{}"))
        doc_id = job.doc_id

    try:
        # ---- INGEST ----------------------------------------------------
        if JobStage.INGEST not in _completed(_job(job_id)):
            if not doc_id:
                doc = _store_upload(upload_filename or "upload.pdf", upload_path or "")
                doc_id = doc.id
            _mark(_job(job_id), JobStage.INGEST)
            _prog(job_id, 5)

        # ---- PARSE -----------------------------------------------------
        parsed = parse_mod.load_parsed(doc_id)
        if parsed is None or JobStage.PARSE not in _completed(_job(job_id)):
            doc = _get_doc(doc_id)
            parsed = parse_mod.parse_document(doc_id, doc.filename, doc.stored_path)
            parse_mod.save_parsed(parsed)
            with SessionLocal() as s:
                d = s.get(Document, doc_id)
                d.layout = parsed.layout
                d.page_count = parsed.page_count
                d.status = "parsed"
                s.commit()
            _mark(_job(job_id), JobStage.PARSE)
            _prog(job_id, 15)

        # ---- ANALYZE ---------------------------------------------------
        analysis = {}
        if JobStage.ANALYZE not in _completed(_job(job_id)):
            doc = _get_doc(doc_id)
            if doc.analysis and doc.analysis != "{}":
                analysis = json.loads(doc.analysis)
            else:
                analysis = gen.analyze(client, parsed)
                with SessionLocal() as s:
                    d = s.get(Document, doc_id)
                    d.analysis = json.dumps(analysis, ensure_ascii=False)
                    s.commit()
            with SessionLocal() as s:
                j = s.get(Job, job_id)
                j.analysis = json.dumps(analysis, ensure_ascii=False)
                s.commit()
            _mark(_job(job_id), JobStage.ANALYZE)
            _prog(job_id, 30)
        else:
            analysis = json.loads(_job(job_id).analysis or "{}")

        # If the user picked a card count, honor it over the suggestion.
        if not config.card_count or config.card_count <= 0:
            config.card_count = analysis.get("suggested_card_count", 30)

        # ---- GENERATE --------------------------------------------------
        plan = gen.plan_chunks(parsed, config, analysis)
        total_targets = sum(p["target"] for p in plan) or 1
        # Cards are committed incrementally so a mid-generation crash keeps
        # what we have; we track how many chunks are done via progress.
        gen_start = 30
        gen_span = 55  # generate spans 30%..85%
        for i, chunk in enumerate(plan):
            # Idempotency: skip chunks already generated. We detect this by
            # counting existing draft cards for this deck that map to these pages.
            existing = _existing_card_pages(deck_id)
            if set(chunk["pages"]) <= existing:
                continue
            cards = gen.generate_cards(client, parsed, config, analysis,
                                       chunk["pages"], chunk["target"])
            _commit_draft_cards(deck_id, cards)
            frac = (i + 1) / len(plan)
            _prog(job_id, gen_start + int(gen_span * frac))
        _mark(_job(job_id), JobStage.GENERATE)

        # ---- FIGURES ---------------------------------------------------
        if config.images and JobStage.FIGURES not in _completed(_job(job_id)):
            doc = _get_doc(doc_id)
            _attach_figures(deck_id, doc.stored_path, parsed)
            _mark(_job(job_id), JobStage.FIGURES)
            _prog(job_id, 90)

        # ---- COMMIT ----------------------------------------------------
        if JobStage.COMMIT not in _completed(_job(job_id)):
            with SessionLocal() as s:
                deck = s.get(Deck, deck_id)
                deck.status = DeckStatus.READY
                s.commit()
            _mark(_job(job_id), JobStage.COMMIT)
            _prog(job_id, 99)

        # ---- FINISHED --------------------------------------------------
        with SessionLocal() as s:
            j = s.get(Job, job_id)
            j.status = JobStatus.DONE
            j.stage = JobStage.FINISHED
            j.progress = 100
            s.commit()
        log.info("job %s done (deck %s)", job_id, deck_id)

    except LLMError as e:
        _fail(job_id, f"LLM error: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("job %s failed", job_id)
        _fail(job_id, f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}")


# ---- small DB helpers (fresh sessions, keep it simple) -----------------

def _job(job_id: str) -> Job:
    with SessionLocal() as s:
        j = s.get(Job, job_id)
        s.expunge(j)
        return j


def _mark(job: Job, stage: JobStage) -> None:
    with SessionLocal() as s:
        j = s.get(Job, job.id)
        _mark_done(j, stage)
        s.commit()


def _prog(job_id: str, pct: int) -> None:
    with SessionLocal() as s:
        j = s.get(Job, job_id)
        j.progress = max(j.progress, min(100, pct))
        s.commit()


def _get_doc(doc_id: str) -> Document:
    with SessionLocal() as s:
        d = s.get(Document, doc_id)
        s.expunge(d)
        return d


def _existing_card_pages(deck_id: str) -> set[int]:
    pages: set[int] = set()
    with SessionLocal() as s:
        cards = s.scalars(select(Card).where(Card.deck_id == deck_id)).all()
        for c in cards:
            try:
                pages.update(json.loads(c.source_pages or "[]"))
            except json.JSONDecodeError:
                pass
    return pages


def _commit_draft_cards(deck_id: str, cards: list[dict]) -> None:
    with SessionLocal() as s:
        for c in cards:
            s.add(Card(
                deck_id=deck_id,
                front=c["front"], back=c["back"],
                card_type=c["type"], topic=c.get("topic", ""),
                difficulty=c.get("difficulty", "medium"),
                status=CardStatus.DRAFT,
                source_pages=json.dumps(c.get("source_slides", [])),
                needs_image=c.get("needs_image", False),
                image_hint=c.get("image_hint", ""),
            ))
        s.commit()


def _attach_figures(deck_id: str, doc_path: str, parsed) -> None:
    with SessionLocal() as s:
        cards = s.scalars(select(Card).where(
            Card.deck_id == deck_id, Card.needs_image.is_(True),
            Card.image_path.is_(None),
        )).all()
        for i, card in enumerate(cards):
            data = {
                "needs_image": True, "image_hint": card.image_hint,
                "source_slides": json.loads(card.source_pages or "[]"),
                "topic": card.topic,
            }
            rel = figures_mod.attach_figure(doc_path, parsed, data, deck_id, i)
            if rel:
                card.image_path = rel
        s.commit()


def _fail(job_id: str, msg: str) -> None:
    with SessionLocal() as s:
        j = s.get(Job, job_id)
        j.status = JobStatus.FAILED
        j.error = msg[:4000]
        s.commit()
    log.error("job %s failed: %s", job_id, msg[:300])


# ---- background dispatch ------------------------------------------------

_active: dict[str, threading.Thread] = {}
_lock = threading.Lock()


def dispatch(job_id: str, upload_path: str | None = None,
             upload_filename: str | None = None) -> bool:
    """Start a job on a background thread. Returns False if already running."""
    with _lock:
        if job_id in _active and _active[job_id].is_alive():
            return False
        t = threading.Thread(
            target=run_job, args=(job_id, upload_path, upload_filename),
            name=f"job-{job_id[:8]}", daemon=True,
        )
        _active[job_id] = t
        t.start()
        return True


def resume_pending() -> None:
    """On app start, re-dispatch any jobs left RUNNING/PENDING (crash recovery)."""
    with SessionLocal() as s:
        jobs = s.scalars(select(Job).where(
            Job.status.in_([JobStatus.RUNNING, JobStatus.PENDING])
        )).all()
        ids = [j.id for j in jobs]
    for jid in ids:
        log.info("resuming pending job %s", jid)
        dispatch(jid)
