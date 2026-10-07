"""Course (folder) management."""
from __future__ import annotations

import re
import unicodedata

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_session_dep
from ..models import Course, Document
from .schemas import CourseCreate, CourseUpdate

router = APIRouter(tags=["courses"])


def _slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name)
    s = s.encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "course"


def _unique_slug(db: Session, name: str, exclude_id: str | None = None) -> str:
    """Return a slug that doesn't clash with another course."""
    base = _slug(name)
    candidate, n = base, 2
    while db.scalar(
        select(Course.id).where(
            Course.slug == candidate,
            (Course.id != exclude_id) if exclude_id else True,
        )
    ):
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def _course_out(c: Course, db: Session) -> dict:
    mat_count = db.scalar(
        select(func.count()).select_from(Document).where(Document.course_id == c.id)
    ) or 0
    return {
        "id": c.id, "name": c.name, "slug": c.slug,
        "description": c.description,
        "deck_count": len(c.decks),
        "card_count": sum(len(d.cards) for d in c.decks),
        "material_count": mat_count,
    }


@router.get("/courses")
def list_courses(db: Session = Depends(get_session_dep)):
    courses = db.scalars(select(Course).order_by(Course.name)).all()
    return [_course_out(c, db) for c in courses]


@router.post("/courses", status_code=201)
def create_course(body: CourseCreate, db: Session = Depends(get_session_dep)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name required")
    if db.scalar(select(Course).where(Course.name == name)):
        raise HTTPException(409, "course already exists")
    course = Course(name=name, slug=_unique_slug(db, name),
                    description=body.description)
    db.add(course)
    db.commit()
    db.refresh(course)
    return _course_out(course, db)


@router.patch("/courses/{course_id}")
def update_course(course_id: str, body: CourseUpdate,
                  db: Session = Depends(get_session_dep)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "not found")
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "name required")
        clash = db.scalar(
            select(Course).where(Course.name == name, Course.id != course_id))
        if clash:
            raise HTTPException(409, "course already exists")
        course.name = name
        course.slug = _unique_slug(db, name, exclude_id=course_id)
    if body.description is not None:
        course.description = body.description
    db.commit()
    db.refresh(course)
    return _course_out(course, db)


@router.delete("/courses/{course_id}", status_code=204)
def delete_course(course_id: str, db: Session = Depends(get_session_dep)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "not found")
    # Detach decks (they survive, become unassigned) rather than deleting.
    for d in course.decks:
        d.course_id = None
    db.delete(course)
    db.commit()
