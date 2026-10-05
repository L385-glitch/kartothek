"""Card review/edit endpoints — the human gate before cards enter the hub."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_session_dep
from ..models import Card, CardStatus, Deck
from .schemas import CardUpdate, card_out

router = APIRouter(tags=["cards"])


@router.get("/decks/{deck_id}/cards")
def list_cards(deck_id: str, status: str | None = None,
               db: Session = Depends(get_session_dep)):
    if not db.get(Deck, deck_id):
        raise HTTPException(404, "deck not found")
    q = select(Card).where(Card.deck_id == deck_id)
    if status:
        q = q.where(Card.status == CardStatus(status))
    cards = db.scalars(q.order_by(Card.created_at)).all()
    return [card_out(c) for c in cards]


@router.patch("/cards/{card_id}")
def update_card(card_id: str, body: CardUpdate, db: Session = Depends(get_session_dep)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404, "not found")
    if body.front is not None:
        card.front = body.front
    if body.back is not None:
        card.back = body.back
    if body.topic is not None:
        card.topic = body.topic
    if body.difficulty is not None:
        from ..models import Difficulty
        card.difficulty = Difficulty(body.difficulty)
    if body.card_type is not None:
        from ..models import CardType
        card.card_type = CardType(body.card_type)
    if body.status is not None:
        card.status = CardStatus(body.status)
    if body.image_path is not None:
        card.image_path = body.image_path
    db.commit()
    db.refresh(card)
    return card_out(card)


@router.post("/cards/{card_id}/approve")
def approve_card(card_id: str, db: Session = Depends(get_session_dep)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404, "not found")
    card.status = CardStatus.APPROVED
    db.commit()
    return card_out(card)


@router.post("/cards/{card_id}/reject")
def reject_card(card_id: str, db: Session = Depends(get_session_dep)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404, "not found")
    card.status = CardStatus.REJECTED
    db.commit()
    return card_out(card)


@router.post("/decks/{deck_id}/approve-all")
def approve_all(deck_id: str, db: Session = Depends(get_session_dep)):
    if not db.get(Deck, deck_id):
        raise HTTPException(404, "deck not found")
    cards = db.scalars(select(Card).where(
        Card.deck_id == deck_id, Card.status == CardStatus.DRAFT)).all()
    for c in cards:
        c.status = CardStatus.APPROVED
    db.commit()
    return {"approved": len(cards)}


@router.delete("/cards/{card_id}", status_code=204)
def delete_card(card_id: str, db: Session = Depends(get_session_dep)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404, "not found")
    db.delete(card)
    db.commit()
