"""Background runner for exam generation and grading.

An ExamJob is either a "generate" job (build exam content from source
documents) or a "grade" job (grade a submitted attempt). Both run on a
background thread; all state lives in the DB so a crash mid-run is
recoverable — resume_pending() re-dispatches anything still DRAFT.

This is intentionally simpler than the card Job (no per-stage resume):
an exam generation is a handful of LLM calls over already-parsed docs,
and grading is a single LLM call. If one fails we mark it failed and the
user can retry from the UI.
"""
from __future__ import annotations

import json
import logging
import threading
import traceback

from sqlalchemy import select

from ..config import settings
from ..database import SessionLocal
from ..llm import LLMClient, LLMError
from ..models import (
    Document, Exam, ExamAttempt, ExamJob, ExamStatus,
)
from . import exam as exam_gen
from . import parse as parse_mod

log = logging.getLogger("studydeck.examjob")


def _prog(job_id: str, pct: int) -> None:
    with SessionLocal() as s:
        j = s.get(ExamJob, job_id)
        if j:
            j.progress = max(j.progress, min(100, pct))
            s.commit()


def _fail(job_id: str, msg: str) -> None:
    with SessionLocal() as s:
        j = s.get(ExamJob, job_id)
        if j:
            j.status = ExamStatus.FAILED
            j.error = msg[:4000]
            s.commit()
    log.error("exam job %s failed: %s", job_id, msg[:300])


def _load_parsed(doc_id: str):
    parsed = parse_mod.load_parsed(doc_id)
    if parsed is None:
        with SessionLocal() as s:
            d = s.get(Document, doc_id)
            if not d:
                return None
            parsed = parse_mod.parse_document(d.id, d.filename, d.stored_path)
            parse_mod.save_parsed(parsed)
    return parsed


def _run_generate(job: ExamJob) -> None:
    """Build exam content from the job's source documents."""
    client = LLMClient()
    doc_ids = [x for x in (job.source_doc_ids or "").split(",") if x]
    config = exam_gen.ExamConfig.from_dict(json.loads(job.config or "{}"))

    # Load (and parse if needed) every source document.
    parsed_docs = []
    for did in doc_ids:
        p = _load_parsed(did)
        if p is not None:
            parsed_docs.append(p)
    if not parsed_docs:
        _fail(job.id, "no readable source documents")
        return

    _prog(job.id, 10)
    # Generate questions per document, then merge. If there are several docs,
    # split the target count across them.
    per_doc = max(1, round(config.question_count / len(parsed_docs)))
    all_questions: list[dict] = []
    for i, p in enumerate(parsed_docs):
        qs = exam_gen.generate_exam(client, p, config)
        all_questions.extend(qs)
        _prog(job.id, 10 + int(80 * (i + 1) / len(parsed_docs)))

    # Trim to the requested total count.
    if config.question_count > 0 and len(all_questions) > config.question_count:
        all_questions = all_questions[:config.question_count]

    total_points = sum(q["points"] for q in all_questions)
    with SessionLocal() as s:
        exam = s.get(Exam, job.exam_id)
        if not exam:
            _fail(job.id, "exam not found")
            return
        exam.content = json.dumps(all_questions, ensure_ascii=False)
        exam.total_points = total_points
        exam.status = ExamStatus.READY
        exam.error = ""
        s.commit()
    _prog(job.id, 100)
    log.info("exam %s generated: %d questions, %d pts", job.exam_id, len(all_questions), total_points)


def _run_grade(job: ExamJob) -> None:
    """Grade a submitted attempt."""
    client = LLMClient()
    with SessionLocal() as s:
        attempt = s.get(ExamAttempt, job.attempt_id)
        if not attempt:
            _fail(job.id, "attempt not found")
            return
        exam = s.get(Exam, attempt.exam_id)
        questions = json.loads(exam.content or "[]")
        answers = json.loads(attempt.answers or "{}")
        note = attempt.resubmit_note or ""
        doc_ids = [x for x in (exam.source_doc_ids or "").split(",") if x]

    # Grading needs the source text; use the first source doc (the exam was
    # generated from it). For multi-doc exams the cited pages are enough.
    parsed = _load_parsed(doc_ids[0]) if doc_ids else None
    if parsed is None:
        # No source available — grade on the answer keys alone (best effort).
        parsed = parse_mod.ParsedDocument(doc_id="", filename="", layout="slide",
                                          page_count=0)

    _prog(job.id, 20)
    grading = exam_gen.grade_attempt(client, parsed, questions, answers, note)
    _prog(job.id, 90)

    score = sum(g["points"] for g in grading)
    max_score = sum(g["max_points"] for g in grading)
    with SessionLocal() as s:
        attempt = s.get(ExamAttempt, job.attempt_id)
        attempt.grading = json.dumps(grading, ensure_ascii=False)
        attempt.score = score
        attempt.max_score = max_score
        attempt.status = "graded"
        attempt.error = ""
        from datetime import datetime, timezone
        attempt.graded_at = datetime.now(timezone.utc)
        s.commit()
    _prog(job.id, 100)
    log.info("attempt %s graded: %d/%d", job.attempt_id, score, max_score)


def run_exam_job(job_id: str) -> None:
    """Execute an exam job (generate or grade) to completion/failure."""
    settings.ensure_dirs()
    with SessionLocal() as s:
        job = s.get(ExamJob, job_id)
        if job is None:
            log.error("exam job %s not found", job_id)
            return
        s.expunge(job)
    try:
        if job.kind == "grade":
            _run_grade(job)
        else:
            _run_generate(job)
        _prog(job_id, 100)
        with SessionLocal() as s:
            j = s.get(ExamJob, job_id)
            j.status = ExamStatus.READY
            j.progress = 100
            s.commit()
    except LLMError as e:
        _fail(job_id, f"LLM error: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("exam job %s failed", job_id)
        _fail(job_id, f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}")


# ---- background dispatch --------------------------------------------------

_active: dict[str, threading.Thread] = {}
_lock = threading.Lock()


def dispatch(job_id: str) -> bool:
    """Start an exam job on a background thread. False if already running."""
    with _lock:
        if job_id in _active and _active[job_id].is_alive():
            return False
        t = threading.Thread(target=run_exam_job, args=(job_id,),
                             name=f"examjob-{job_id[:8]}", daemon=True)
        _active[job_id] = t
        t.start()
        return True


def resume_pending() -> None:
    """On app start, re-dispatch exam jobs left in flight (crash recovery)."""
    with SessionLocal() as s:
        jobs = s.scalars(select(ExamJob).where(
            ExamJob.status == ExamStatus.DRAFT
        )).all()
        ids = [j.id for j in jobs]
    for jid in ids:
        log.info("resuming pending exam job %s", jid)
        dispatch(jid)
