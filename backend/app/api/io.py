"""Import / export: CSV, JSON, and Anki APKG.

Export:
  GET /api/decks/{id}/export?format=csv|json|apkg
Import:
  POST /api/decks/{id}/import   (multipart file: csv or json) -> adds cards
"""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..anki_io import build_apkg
from ..config import settings
from ..database import get_session_dep
from ..models import Card, CardStatus, CardType, Deck, Difficulty
from .schemas import card_out

router = APIRouter(tags=["io"])


def _deck_cards(db: Session, deck_id: str) -> list[Card]:
    deck = db.get(Deck, deck_id)
    if not deck:
        raise HTTPException(404, "deck not found")
    cards = db.scalars(select(Card).where(
        Card.deck_id == deck_id, Card.status != CardStatus.REJECTED)).all()
    return list(cards)


def _image_bytes(card: Card) -> bytes | None:
    if not card.image_path:
        return None
    p = settings.figures_dir / card.image_path
    if p.exists():
        return p.read_bytes()
    return None


@router.get("/decks/{deck_id}/export")
def export_deck(deck_id: str, format: str = "csv",
                db: Session = Depends(get_session_dep)):
    cards = _deck_cards(db, deck_id)
    deck = db.get(Deck, deck_id)
    name = deck.name.replace(" ", "_")

    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["front", "back", "type", "topic", "difficulty",
                    "source_pages", "image_hint"])
        for c in cards:
            w.writerow([c.front, c.back, c.card_type.value, c.topic,
                        c.difficulty.value, json.loads(c.source_pages or "[]"),
                        c.image_hint])
        return Response(
            content=buf.getvalue().encode("utf-8"),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{name}.csv"'},
        )

    if format == "json":
        payload = {"deck": deck.name, "language": deck.language,
                   "cards": [card_out(c) for c in cards]}
        return Response(
            content=json.dumps(payload, ensure_ascii=False, indent=2).encode(),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{name}.json"'},
        )

    if format == "apkg":
        anki_cards = []
        media: dict[str, bytes] = {}
        for i, c in enumerate(cards):
            img = _image_bytes(c)
            anki_cards.append({"front": c.front, "back": c.back,
                               "topic": c.topic, "image": img})
        settings.ensure_dirs()
        out = str(settings.exports_dir / f"{name}.apkg")
        build_apkg(deck.name, anki_cards, media, out)
        data = Path(out).read_bytes()
        return Response(
            content=data,
            media_type="application/x-anki2",
            headers={"Content-Disposition": f'attachment; filename="{name}.apkg"'},
        )

    raise HTTPException(400, f"unknown format {format!r} (use csv|json|apkg)")


def _parse_csv(text: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text))
    out = []
    for row in reader:
        front = (row.get("front") or "").strip()
        back = (row.get("back") or "").strip()
        if not front or not back:
            continue
        out.append({
            "front": front, "back": back,
            "type": row.get("type") or "qa",
            "topic": row.get("topic") or "",
            "difficulty": row.get("difficulty") or "medium",
            "source_pages": row.get("source_pages") or "[]",
            "image_hint": row.get("image_hint") or "",
        })
    return out


@router.post("/decks/{deck_id}/import")
async def import_deck(deck_id: str, file: UploadFile = File(...),
                      db: Session = Depends(get_session_dep)):
    if not db.get(Deck, deck_id):
        raise HTTPException(404, "deck not found")
    raw = (await file.read()).decode("utf-8-sig")
    fname = (file.filename or "").lower()

    if fname.endswith(".json") or raw.lstrip().startswith("{"):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"invalid JSON: {e}")
        rows = payload.get("cards", payload if isinstance(payload, list) else [])
        parsed = []
        for r in rows:
            front = (r.get("front") or "").strip()
            back = (r.get("back") or "").strip()
            if not front or not back:
                continue
            parsed.append({
                "front": front, "back": back,
                "type": r.get("type") or "qa",
                "topic": r.get("topic") or "",
                "difficulty": r.get("difficulty") or "medium",
                "source_pages": json.dumps(r.get("source_pages") or []),
                "image_hint": r.get("image_hint") or "",
            })
    else:
        parsed = _parse_csv(raw)

    if not parsed:
        raise HTTPException(400, "no valid cards found in file")

    added = 0
    for p in parsed:
        try:
            ctype = CardType(p["type"])
        except ValueError:
            ctype = CardType.QA
        try:
            diff = Difficulty(p["difficulty"])
        except ValueError:
            diff = Difficulty.MEDIUM
        db.add(Card(
            deck_id=deck_id, front=p["front"], back=p["back"],
            card_type=ctype, topic=p["topic"], difficulty=diff,
            status=CardStatus.APPROVED,  # imported cards are ready to study
            source_pages=p["source_pages"],
        ))
        added += 1
    db.commit()
    return {"imported": added}
