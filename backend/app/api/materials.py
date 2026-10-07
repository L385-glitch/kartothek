"""Materials library ("Neue Karten") — the pool of imported source PDFs.

Documents are uploaded via POST /api/documents (see jobs.py). This router
adds the library view: list them (optionally by course), assign a course
so they group in the UI, and remove them from the library.

GET    /api/materials?course_id=...   list documents (course_id optional)
POST   /api/materials/{id}/assign     set course_id (null = unassigned)
DELETE /api/materials/{id}            remove from library (+ file on disk)
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_session_dep
from ..models import Course, Document
from .schemas import DocAssign, doc_out

router = APIRouter(tags=["materials"])


@router.get("/materials")
def list_materials(course_id: str | None = None,
                   db: Session = Depends(get_session_dep)):
    q = select(Document)
    if course_id:
        q = q.where(Document.course_id == course_id)
    docs = db.scalars(q.order_by(Document.created_at.desc())).all()
    return [doc_out(d) for d in docs]


@router.post("/materials/{doc_id}/assign")
def assign_material(doc_id: str, body: DocAssign,
                    db: Session = Depends(get_session_dep)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404, "not found")
    if body.course_id and not db.get(Course, body.course_id):
        raise HTTPException(404, "course not found")
    doc.course_id = body.course_id
    db.commit()
    db.refresh(doc)
    return doc_out(doc)


@router.delete("/materials/{doc_id}", status_code=204)
def delete_material(doc_id: str, db: Session = Depends(get_session_dep)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404, "not found")
    # Remove the uploaded file if it exists and lives under uploads.
    try:
        p = Path(doc.stored_path)
        if p.exists() and str(p).startswith(str(settings.uploads_dir)):
            p.unlink()
    except OSError:
        pass
    db.delete(doc)
    db.commit()
