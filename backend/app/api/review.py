"""Study/review endpoints — the FSRS spaced-repetition loop.

A "study session" pulls due cards (new + due-for-review) for a deck or
course, the user rates each (Again/Hard/Good/Easy), and the scheduler
re-queues them. Stats expose due counts so the UI can show "X due".
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_session_dep
from ..models import Card, CardStatus, Deck, ReviewState
from .. import srs
from .schemas import ReviewRequest, card_out, review_out

router = APIRouter(tags=["review"])


def _ensure_state(card: Card) -> ReviewState:
    if card.review is None:
        card.review = ReviewState(card_id=card.id)
    return card.review


def _approved_cards(db: Session, deck_ids: list[str]) -> list[Card]:
    if not deck_ids:
        return []
    cards = db.scalars(select(Card).where(
        Card.deck_id.in_(deck_ids), Card.status == CardStatus.APPROVED)).all()
    return list(cards)


def _deck_ids_for_course(db: Session, course_id: str) -> list[str]:
    decks = db.scalars(select(Deck).where(Deck.course_id == course_id)).all()
    return [d.id for d in decks]


@router.get("/study/due")
def due_cards(deck_id: str | None = None, course_id: str | None = None,
              limit: int = 50, db: Session = Depends(get_session_dep)):
    """Cards due now: all new approved cards + cards whose FSRS due <= now."""
    if deck_id:
        ids = [deck_id]
    elif course_id:
        ids = _deck_ids_for_course(db, course_id)
    else:
        ids = [d.id for d in db.scalars(select(Deck)).all()]
    cards = _approved_cards(db, ids)
    now = datetime.now(timezone.utc)
    due = []
    for c in cards:
        st = _ensure_state(c)
        if srs.is_due(st, now):
            due.append(c)
        if len(due) >= limit:
            break
    db.commit()
    return [card_out(c) for c in due]


@router.post("/study/review/{card_id}")
def review_card(card_id: str, body: ReviewRequest, db: Session = Depends(get_session_dep)):
    """Record a rating and reschedule the card via FSRS."""
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404, "not found")
    st = _ensure_state(card)
    new_state = srs.review(st, body.rating)
    st.stability = new_state.stability
    st.difficulty = new_state.difficulty
    st.due = new_state.due
    st.last_review = new_state.last_review
    st.reps = new_state.reps
    st.lapses = new_state.lapses
    st.state = new_state.state
    db.commit()
    return review_out(st)


@router.get("/stats")
def stats(db: Session = Depends(get_session_dep)):
    """Due counts per deck + totals, for the hub dashboard."""
    now = datetime.now(timezone.utc)
    decks = db.scalars(select(Deck)).all()
    out = []
    total_due = 0
    total_new = 0
    total_cards = 0
    for d in decks:
        cards = db.scalars(select(Card).where(
            Card.deck_id == d.id, Card.status == CardStatus.APPROVED)).all()
        due = new = 0
        for c in cards:
            st = _ensure_state(c)
            if st.state == 0:
                new += 1
            if srs.is_due(st, now):
                due += 1
        total_due += due
        total_new += new
        total_cards += len(cards)
        out.append({
            "deck_id": d.id, "course_id": d.course_id, "name": d.name,
            "cards": len(cards), "due": due, "new": new,
        })
    db.commit()
    return {"decks": out, "total_due": total_due,
            "total_new": total_new, "total_cards": total_cards}
