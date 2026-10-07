"""Exercises & mock exams (Prüfungen/Übungen) + grading.

Flow the frontend follows:
  1. POST /api/exams/generate   -> create exam + generation job, start (202)
  2. GET  /api/exam-jobs/{id}   -> poll until ready
  3. GET  /api/exams/{id}       -> read the questions
  4. POST /api/exams/{id}/attempts           -> submit answers (starts grading)
  5. GET  /api/exams/{id}/attempts           -> poll the graded attempt
  6. POST /api/exams/{id}/attempts/{aid}/resubmit -> re-upload answers + note
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_session_dep
from ..models import (
    Course, Document, Exam, ExamAttempt, ExamJob, ExamKind, ExamStatus,
)
from ..pipeline import exam as exam_gen
from ..pipeline import exam_jobs as exam_runner
from .jobs import active_create_job
from .schemas import (
    AttemptResubmit, AttemptSubmit, ExamGenerateRequest, ExamMove, ExamRename,
    attempt_out, exam_detail_out, exam_job_out, exam_out,
)

router = APIRouter(tags=["exams"])


def _kind(kind: str) -> ExamKind:
    try:
        return ExamKind(kind)
    except ValueError:
        raise HTTPException(400, f"unknown kind {kind!r} (use exam|exercise)")


def _default_name(course: Course | None, kind: ExamKind) -> str:
    label = "Prüfung" if kind == ExamKind.EXAM else "Übung"
    course_name = course.name if course else "Unzugeordnet"
    return f"{label}: {course_name}"


# ---------- generation ----------

@router.post("/exams/generate", status_code=202)
def generate_exam(body: ExamGenerateRequest, db: Session = Depends(get_session_dep)):
    """Create an exam (DRAFT) + a background generation job, and start it."""
    # Only one create job at a time (cards or exam) — the UI relies on this.
    if active_create_job(db) is not None:
        raise HTTPException(409, "ein Erstellungs-Job läuft bereits")
    if not body.doc_ids:
        raise HTTPException(400, "at least one doc_id required")
    kind = _kind(body.kind)

    # Validate + resolve course.
    course = None
    if body.course_id:
        course = db.get(Course, body.course_id)
        if not course:
            raise HTTPException(404, "course not found")
    # Verify all docs exist.
    for did in body.doc_ids:
        if not db.get(Document, did):
            raise HTTPException(404, f"doc {did} not found")

    name = (body.name or "").strip() or _default_name(course, kind)
    config = exam_gen.ExamConfig(
        kind=kind.value, question_count=body.question_count,
        question_types=body.question_types, difficulties=body.difficulties,
        focus=body.focus, language=body.language,
    ).to_dict()

    exam = Exam(
        course_id=body.course_id, name=name, kind=kind,
        status=ExamStatus.DRAFT, source_doc_ids=",".join(body.doc_ids),
        config=json.dumps(config, ensure_ascii=False),
    )
    db.add(exam)
    db.flush()

    job = ExamJob(
        exam_id=exam.id, kind="generate", status=ExamStatus.DRAFT,
        source_doc_ids=",".join(body.doc_ids),
        config=json.dumps(config, ensure_ascii=False),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    started = exam_runner.dispatch(job.id)
    if not started:
        raise HTTPException(409, "job already running")
    return {"exam": exam_out(exam), "job": exam_job_out(job)}


# ---------- exam CRUD ----------

@router.get("/exams")
def list_exams(course_id: str | None = None, kind: str | None = None,
               db: Session = Depends(get_session_dep)):
    q = select(Exam)
    if course_id:
        q = q.where(Exam.course_id == course_id)
    if kind:
        q = q.where(Exam.kind == _kind(kind))
    exams = db.scalars(q.order_by(Exam.created_at.desc())).all()
    return [exam_out(e) for e in exams]


@router.get("/exams/{exam_id}")
def get_exam(exam_id: str, db: Session = Depends(get_session_dep)):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(404, "not found")
    return exam_detail_out(exam)


@router.patch("/exams/{exam_id}")
def rename_exam(exam_id: str, body: ExamRename,
                db: Session = Depends(get_session_dep)):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(404, "not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name required")
    exam.name = name
    db.commit()
    db.refresh(exam)
    return exam_out(exam)


@router.post("/exams/{exam_id}/move")
def move_exam(exam_id: str, body: ExamMove,
              db: Session = Depends(get_session_dep)):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(404, "not found")
    if body.course_id and not db.get(Course, body.course_id):
        raise HTTPException(404, "course not found")
    exam.course_id = body.course_id
    db.commit()
    db.refresh(exam)
    return exam_out(exam)


@router.delete("/exams/{exam_id}", status_code=204)
def delete_exam(exam_id: str, db: Session = Depends(get_session_dep)):
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(404, "not found")
    db.delete(exam)
    db.commit()


# ---------- exam jobs (polling) ----------

@router.get("/exam-jobs/{job_id}")
def get_exam_job(job_id: str, db: Session = Depends(get_session_dep)):
    job = db.get(ExamJob, job_id)
    if not job:
        raise HTTPException(404, "not found")
    return exam_job_out(job)


@router.post("/exam-jobs/{job_id}/retry")
def retry_exam_job(job_id: str, db: Session = Depends(get_session_dep)):
    job = db.get(ExamJob, job_id)
    if not job:
        raise HTTPException(404, "not found")
    if job.status == ExamStatus.DRAFT:
        raise HTTPException(409, "already running")
    job.status = ExamStatus.DRAFT
    job.error = ""
    db.commit()
    started = exam_runner.dispatch(job.id)
    if not started:
        raise HTTPException(409, "could not start")
    return exam_job_out(job)


# ---------- attempts (taking + grading) ----------

def _start_grading(db: Session, attempt: ExamAttempt) -> ExamJob:
    """Create + dispatch a grading job for an attempt (status=pending)."""
    attempt.status = "pending"
    db.flush()
    job = ExamJob(exam_id=attempt.exam_id, attempt_id=attempt.id,
                  kind="grade", status=ExamStatus.DRAFT)
    db.add(job)
    db.commit()
    db.refresh(job)
    started = exam_runner.dispatch(job.id)
    if not started:
        raise HTTPException(409, "grading already running")
    return job


@router.post("/exams/{exam_id}/attempts", status_code=202)
def submit_attempt(exam_id: str, body: AttemptSubmit,
                   db: Session = Depends(get_session_dep)):
    """Submit answers for an exam; starts background grading."""
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(404, "not found")
    if exam.status != ExamStatus.READY:
        raise HTTPException(409, f"exam not ready (status={exam.status.value})")
    questions = json.loads(exam.content or "[]")
    if not questions:
        raise HTTPException(409, "exam has no questions")

    # Normalize answers to the known question ids.
    answers = {}
    for q in questions:
        answers[q["id"]] = str(body.answers.get(q["id"], "")).strip()

    attempt = ExamAttempt(exam_id=exam_id, answers=json.dumps(answers, ensure_ascii=False))
    db.add(attempt)
    job = _start_grading(db, attempt)
    db.refresh(attempt)
    return {"attempt": attempt_out(attempt), "job": exam_job_out(job)}


@router.get("/exams/{exam_id}/attempts")
def list_attempts(exam_id: str, db: Session = Depends(get_session_dep)):
    if not db.get(Exam, exam_id):
        raise HTTPException(404, "not found")
    attempts = db.scalars(select(ExamAttempt).where(
        ExamAttempt.exam_id == exam_id).order_by(ExamAttempt.created_at.desc())).all()
    return [attempt_out(a) for a in attempts]


@router.get("/exams/{exam_id}/attempts/{attempt_id}")
def get_attempt(exam_id: str, attempt_id: str,
                db: Session = Depends(get_session_dep)):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.exam_id != exam_id:
        raise HTTPException(404, "not found")
    return attempt_out(attempt)


@router.post("/exams/{exam_id}/attempts/{attempt_id}/resubmit", status_code=202)
def resubmit_attempt(exam_id: str, attempt_id: str, body: AttemptResubmit,
                     db: Session = Depends(get_session_dep)):
    """Re-upload answers (and an optional note) and re-grade the attempt."""
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(404, "not found")
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.exam_id != exam_id:
        raise HTTPException(404, "not found")

    questions = json.loads(exam.content or "[]")
    # Merge: keep stored answers, override with any provided.
    answers = json.loads(attempt.answers or "{}")
    if body.answers:
        for q in questions:
            if q["id"] in body.answers:
                answers[q["id"]] = str(body.answers[q["id"]]).strip()
    attempt.answers = json.dumps(answers, ensure_ascii=False)
    attempt.resubmit_note = (body.note or "").strip()
    # Reset previous grading; it will be recomputed.
    attempt.grading = "{}"
    attempt.score = 0
    attempt.max_score = 0

    job = _start_grading(db, attempt)
    db.refresh(attempt)
    return {"attempt": attempt_out(attempt), "job": exam_job_out(job)}


@router.delete("/exams/{exam_id}/attempts/{attempt_id}", status_code=204)
def delete_attempt(exam_id: str, attempt_id: str,
                   db: Session = Depends(get_session_dep)):
    attempt = db.get(ExamAttempt, attempt_id)
    if not attempt or attempt.exam_id != exam_id:
        raise HTTPException(404, "not found")
    db.delete(attempt)
    db.commit()
