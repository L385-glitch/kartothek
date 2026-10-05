"""Course (folder) management."""
from __future__ import annotations

import re
import unicodedata

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_session_dep
from ..models import Course, Deck
from .schemas import CourseCreate, deck_out

router = APIRouter(tags=["courses"])


def _slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name)
    s = s.encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "course"


@router.get("/courses")
def list_courses(db: Session = Depends(get_session_dep)):
    courses = db.scalars(select(Course).order_by(Course.name)).all()
    out = []
    for c in courses:
        out.append({
            "id": c.id, "name": c.name, "slug": c.slug,
            "description": c.description,
            "deck_count": len(c.decks),
            "card_count": sum(len(d.cards) for d in c.decks),
        })
    return out


@router.post("/courses", status_code=201)
def create_course(body: CourseCreate, db: Session = Depends(get_session_dep)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name required")
    if db.scalar(select(Course).where(Course.name == name)):
        raise HTTPException(409, "course already exists")
    course = Course(name=name, slug=_slug(name), description=body.description)
    db.add(course)
    db.commit()
    db.refresh(course)
    return {"id": course.id, "name": course.name, "slug": course.slug}


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
