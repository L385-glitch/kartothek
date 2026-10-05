"""SQLAlchemy ORM models.

Relationships:
  Course 1--* Deck
  Document 1--* Deck  (a deck is generated from one or more documents)
  Deck   1--* Card
  Card   1--1 ReviewState
  Job    *--1 Deck    (each generation run is a resumable job)
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CardType(str, enum.Enum):
    QA = "qa"
    CLOZE = "cloze"
    MC = "mc"


class Difficulty(str, enum.Enum):
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


class CardStatus(str, enum.Enum):
    DRAFT = "draft"
    APPROVED = "approved"
    REJECTED = "rejected"


class DeckStatus(str, enum.Enum):
    DRAFT = "draft"
    READY = "ready"


class JobStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class JobStage(str, enum.Enum):
    INGEST = "ingest"
    PARSE = "parse"
    ANALYZE = "analyze"
    GENERATE = "generate"
    FIGURES = "figures"
    COMMIT = "commit"
    FINISHED = "finished"


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    slug: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    decks: Mapped[list["Deck"]] = relationship(back_populates="course", cascade="all, delete-orphan")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uid)
    filename: Mapped[str] = mapped_column(String(512))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    stored_path: Mapped[str] = mapped_column(String(1024))
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    # "slide" (PowerPoint-derived) or "book" (continuous text) — set by parse.
    layout: Mapped[str] = mapped_column(String(16), default="unknown")
    status: Mapped[str] = mapped_column(String(16), default="stored")
    # Cached analysis JSON (topics, suggested count) — set by the analyze step.
    analysis: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Deck(Base):
    __tablename__ = "decks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uid)
    course_id: Mapped[str | None] = mapped_column(
        ForeignKey("courses.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(8), default="de")
    status: Mapped[DeckStatus] = mapped_column(
        Enum(DeckStatus), default=DeckStatus.DRAFT, index=True
    )
    source_doc_ids: Mapped[str] = mapped_column(Text, default="")  # comma-sep doc ids
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    course: Mapped["Course | None"] = relationship(back_populates="decks")
    cards: Mapped[list["Card"]] = relationship(back_populates="deck", cascade="all, delete-orphan")


class Card(Base):
    __tablename__ = "cards"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uid)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    front: Mapped[str] = mapped_column(Text)
    back: Mapped[str] = mapped_column(Text)
    card_type: Mapped[CardType] = mapped_column(Enum(CardType), default=CardType.QA)
    topic: Mapped[str] = mapped_column(String(255), default="", index=True)
    difficulty: Mapped[Difficulty] = mapped_column(Enum(Difficulty), default=Difficulty.MEDIUM)
    status: Mapped[CardStatus] = mapped_column(Enum(CardStatus), default=CardStatus.DRAFT, index=True)
    # Provenance: JSON list of slide/page numbers, e.g. [21, 22]
    source_pages: Mapped[str] = mapped_column(Text, default="[]")
    # Image
    needs_image: Mapped[bool] = mapped_column(Boolean, default=False)
    image_hint: Mapped[str] = mapped_column(Text, default="")
    image_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    deck: Mapped["Deck"] = relationship(back_populates="cards")
    review: Mapped["ReviewState | None"] = relationship(
        back_populates="card", uselist=False, cascade="all, delete-orphan"
    )


class ReviewState(Base):
    """One row per card holding FSRS scheduler state."""
    __tablename__ = "review_states"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uid)
    card_id: Mapped[str] = mapped_column(
        ForeignKey("cards.id", ondelete="CASCADE"), unique=True, index=True
    )
    # FSRS parameters (per-card, initialized to defaults on first review)
    stability: Mapped[float] = mapped_column(Float, default=0.0)
    difficulty: Mapped[float] = mapped_column(Float, default=0.0)
    due: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_review: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    # 0=new 1=learning 2=review 3=relearning
    state: Mapped[int] = mapped_column(Integer, default=0)

    card: Mapped["Card"] = relationship(back_populates="review")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uid)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    doc_id: Mapped[str | None] = mapped_column(ForeignKey("documents.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.PENDING, index=True)
    stage: Mapped[JobStage] = mapped_column(Enum(JobStage), default=JobStage.INGEST)
    # Which stages have completed (comma-sep) — drives resume.
    completed_stages: Mapped[str] = mapped_column(Text, default="")
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0-100
    # Generation config snapshot (JSON): topics, count, types, difficulty, language, images
    config: Mapped[str] = mapped_column(Text, default="{}")
    # Analysis result (JSON): topics, suggested count, difficulty mix
    analysis: Mapped[str] = mapped_column(Text, default="{}")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
