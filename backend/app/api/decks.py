"""Deck CRUD + moving decks into courses (the 'learning hub' structure)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_session_dep
from ..models import Card, CardStatus, Course, Deck, DeckStatus
from .schemas import DeckCreate, DeckMove, card_out, deck_out

router = APIRouter(tags=["decks"])


@router.get("/decks")
def list_decks(course_id: str | None = None, db: Session = Depends(get_session_dep)):
    q = select(Deck)
    if course_id:
        q = q.where(Deck.course_id == course_id)
    decks = db.scalars(q.order_by(Deck.created_at.desc())).all()
    return [deck_out(d) for d in decks]


@router.post("/decks", status_code=201)
def create_deck(body: DeckCreate, db: Session = Depends(get_session_dep)):
    if body.course_id and not db.get(Course, body.course_id):
        raise HTTPException(400, "unknown course_id")
    deck = Deck(
        course_id=body.course_id, name=body.name.strip() or "Neues Deck",
        description=body.description, language=body.language,
        status=DeckStatus.DRAFT,
    )
    db.add(deck)
    db.commit()
    db.refresh(deck)
    return deck_out(deck)


@router.get("/decks/{deck_id}")
def get_deck(deck_id: str, db: Session = Depends(get_session_dep)):
    deck = db.get(Deck, deck_id)
    if not deck:
        raise HTTPException(404, "not found")
    cards = db.scalars(select(Card).where(Card.deck_id == deck_id)
                       .order_by(Card.created_at)).all()
    return {
        **deck_out(deck),
        "cards": [card_out(c) for c in cards],
    }


@router.patch("/decks/{deck_id}")
def move_deck(deck_id: str, body: DeckMove, db: Session = Depends(get_session_dep)):
    """Move a deck into (or out of) a course — the hub's folder structure."""
    deck = db.get(Deck, deck_id)
    if not deck:
        raise HTTPException(404, "not found")
    if body.course_id and not db.get(Course, body.course_id):
        raise HTTPException(400, "unknown course_id")
    deck.course_id = body.course_id
    db.commit()
    return deck_out(deck)


@router.delete("/decks/{deck_id}", status_code=204)
def delete_deck(deck_id: str, db: Session = Depends(get_session_dep)):
    deck = db.get(Deck, deck_id)
    if not deck:
        raise HTTPException(404, "not found")
    db.delete(deck)
    db.commit()
