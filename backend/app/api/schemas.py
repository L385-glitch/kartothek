"""Pydantic schemas + ORM serializers shared across routers."""
from __future__ import annotations

import json
from datetime import datetime

from pydantic import BaseModel, Field

from ..models import (
    Card, CardStatus, CardType, Deck, DeckStatus, Difficulty, Document,
    Job, JobStage, JobStatus, ReviewState,
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


# ---------- serializers ----------

def _dt(x: datetime | None):
    return x.isoformat() if x else None


def doc_out(d: Document) -> dict:
    return {
        "id": d.id, "filename": d.filename, "sha256": d.sha256,
        "page_count": d.page_count, "layout": d.layout, "status": d.status,
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
