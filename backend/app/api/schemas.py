"""Pydantic schemas + ORM serializers shared across routers."""
from __future__ import annotations

import json
from datetime import datetime

from pydantic import BaseModel, Field

from ..models import (
    Card, CardStatus, CardType, Deck, DeckStatus, Difficulty, Document,
    Exam, ExamAttempt, ExamJob, Job, JobStage, JobStatus, ReviewState,
)


# ---------- request schemas ----------

class CourseCreate(BaseModel):
    name: str
    description: str = ""


class DeckCreate(BaseModel):
    course_id: str | None = None
    name: str
    description: str = ""
    language: str = "de"


class GenerateRequest(BaseModel):
    doc_id: str
    config: dict = Field(default_factory=dict)
    # When True the upload has already been stored under this temp path.
    upload_path: str | None = None
    upload_filename: str | None = None


class AnalyzeRequest(BaseModel):
    doc_id: str


class CardUpdate(BaseModel):
    front: str | None = None
    back: str | None = None
    topic: str | None = None
    difficulty: str | None = None
    card_type: str | None = None
    status: str | None = None
    image_path: str | None = None


class ReviewRequest(BaseModel):
    rating: int = Field(ge=1, le=4)


class DeckMove(BaseModel):
    course_id: str | None = None


# ---------- exam / materials request schemas ----------

class DocAssign(BaseModel):
    course_id: str | None = None


class ExamGenerateRequest(BaseModel):
    course_id: str | None = None
    name: str | None = None
    kind: str = "exam"            # "exam" | "exercise"
    doc_ids: list[str] = Field(default_factory=list)
    question_count: int = Field(default=12, ge=1, le=60)
    question_types: list[str] = Field(default_factory=lambda: ["mc", "short", "long"])
    difficulties: list[str] = Field(default_factory=lambda: ["easy", "medium", "hard"])
    focus: str = ""
    language: str = "de"


class ExamRename(BaseModel):
    name: str


class ExamMove(BaseModel):
    course_id: str | None = None


class AttemptSubmit(BaseModel):
    # question id -> answer (letter for mc, free text for short/long)
    answers: dict = Field(default_factory=dict)


class AttemptResubmit(BaseModel):
    # Updated answers (replaces the stored ones) — the "re-upload" loop.
    answers: dict | None = None
    # Optional note explaining what changed / asking for re-grading.
    note: str = ""


# ---------- serializers ----------

def _dt(x: datetime | None):
    return x.isoformat() if x else None


def doc_out(d: Document) -> dict:
    return {
        "id": d.id, "filename": d.filename, "sha256": d.sha256,
        "page_count": d.page_count, "layout": d.layout, "status": d.status,
        "course_id": d.course_id,
        "analysis": json.loads(d.analysis or "{}"),
        "created_at": _dt(d.created_at),
    }


def deck_out(d: Deck) -> dict:
    return {
        "id": d.id, "course_id": d.course_id, "name": d.name,
        "description": d.description, "language": d.language,
        "status": d.status.value,
        "card_count": len(d.cards),
        "approved_count": sum(1 for c in d.cards if c.status == CardStatus.APPROVED),
        "created_at": _dt(d.created_at),
    }


def card_out(c: Card) -> dict:
    return {
        "id": c.id, "deck_id": c.deck_id,
        "front": c.front, "back": c.back,
        "type": c.card_type.value, "topic": c.topic,
        "difficulty": c.difficulty.value, "status": c.status.value,
        "source_pages": json.loads(c.source_pages or "[]"),
        "needs_image": c.needs_image, "image_hint": c.image_hint,
        "image_path": c.image_path,
        "created_at": _dt(c.created_at),
    }


def job_out(j: Job) -> dict:
    return {
        "id": j.id, "deck_id": j.deck_id, "doc_id": j.doc_id,
        "status": j.status.value, "stage": j.stage.value,
        "progress": j.progress,
        "config": json.loads(j.config or "{}"),
        "analysis": json.loads(j.analysis or "{}"),
        "error": j.error,
        "created_at": _dt(j.created_at), "updated_at": _dt(j.updated_at),
    }


def review_out(r: ReviewState) -> dict:
    return {
        "card_id": r.card_id, "stability": r.stability,
        "difficulty": r.difficulty, "due": _dt(r.due),
        "last_review": _dt(r.last_review), "reps": r.reps,
        "lapses": r.lapses, "state": r.state,
    }


# ---------- exam serializers ----------

def exam_out(e: Exam) -> dict:
    return {
        "id": e.id, "course_id": e.course_id, "name": e.name,
        "kind": e.kind.value, "status": e.status.value,
        "source_doc_ids": [x for x in (e.source_doc_ids or "").split(",") if x],
        "total_points": e.total_points,
        "question_count": len(json.loads(e.content or "[]")),
        "config": json.loads(e.config or "{}"),
        "error": e.error,
        "created_at": _dt(e.created_at), "updated_at": _dt(e.updated_at),
    }


def exam_detail_out(e: Exam) -> dict:
    d = exam_out(e)
    d["content"] = json.loads(e.content or "[]")
    return d


def attempt_out(a: ExamAttempt) -> dict:
    grading = json.loads(a.grading or "{}")
    # Stored as a list aligned to the questions; expose it keyed by question id.
    if isinstance(grading, list):
        grading = {g.get("id"): g for g in grading if isinstance(g, dict)}
    return {
        "id": a.id, "exam_id": a.exam_id,
        "answers": json.loads(a.answers or "{}"),
        "grading": grading,
        "score": a.score, "max_score": a.max_score,
        "status": a.status,
        "resubmit_note": a.resubmit_note,
        "error": a.error,
        "created_at": _dt(a.created_at), "graded_at": _dt(a.graded_at),
    }


def exam_job_out(j: ExamJob) -> dict:
    return {
        "id": j.id, "exam_id": j.exam_id, "attempt_id": j.attempt_id,
        "kind": j.kind, "status": j.status.value, "progress": j.progress,
        "source_doc_ids": [x for x in (j.source_doc_ids or "").split(",") if x],
        "config": json.loads(j.config or "{}"),
        "error": j.error,
        "created_at": _dt(j.created_at), "updated_at": _dt(j.updated_at),
    }
