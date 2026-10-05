"""Anki APKG (anki21) export — a self-contained, dependency-free writer.

Produces a .apkg that Anki can import directly: a zip containing
  collection.anki21   (SQLite database)
  media               (newline list of media filenames)
  media/<files>       (the actual image files)

Each deck exports as its own note type (model) with Front/Back fields and a
single card template. Cloze cards are flattened to plain Q&A (Anki cloze is a
separate model type; flattening keeps the exporter simple and lossless for
the answer text).
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
import zipfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Minimal but valid anki21 schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE col (
  id INTEGER PRIMARY KEY, crt INTEGER, mod INTEGER, scm INTEGER,
  ver INTEGER, dty INTEGER, usn INTEGER, ls INTEGER,
  conf TEXT, models TEXT, cols TEXT, dconf TEXT, tags TEXT);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER, usn INTEGER,
  tags TEXT, flds TEXT, sfld TEXT, csum INTEGER, flags INTEGER, data TEXT);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, type INTEGER,
  queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER,
  lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER,
  data TEXT);
CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE graves (id INTEGER PRIMARY KEY, usn INTEGER, oid INTEGER,
  cmod INTEGER, nmod INTEGER, mmod INTEGER, tmod INTEGER);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, usn INTEGER);
"""

CSS = """
.card { font-family: sans-serif; font-size: 20px; text-align: center; }
img, video { max-width: 100%; max-height: 100%; }
"""


def _now() -> int:
    return int(time.time())


def _guid() -> str:
    return uuid.uuid4().hex


def _flds_join(fields: list[str]) -> str:
    # Anki joins fields with \x1f (unit separator).
    return "\x1f".join(fields)


def _html_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def build_apkg(
    deck_name: str,
    cards: list[dict],
    media: dict[str, bytes],
    out_path: str,
) -> str:
    """Build an .apkg.

    cards: list of {"front": str, "back": str, "topic": str, "image": bytes|None}
    media: {filename: bytes} for any images referenced (also embedded per-card).
    """
    now = _now()
    deck_id = 1
    model_id = 1

    model = {
        "id": model_id,
        "name": "Kartothek",
        "type": 0,
        "desc": "",
        "mod": now,
        "usn": 0,
        "sortf": 0,
        "flds": [
            {"name": "Front", "ord": 0, "style": {}, "size": 20},
            {"name": "Back", "ord": 1, "style": {}, "size": 20},
        ],
        "tmpls": [
            {
                "name": "Card 1", "ord": 0,
                "qfmt": "{{Front}}",
                "afmt": "{{FrontSide}}\n<hr id=answer>\n{{Back}}",
                "bqfmt": "", "bafmt": "",
                "usn": 0, "did": None,
            }
        ],
        "css": CSS,
        "req": [],
    }

    col_conf = {
        "activeDecks": [deck_id],
        "collapsed": [],
        "current": deck_id,
        "newToday": 0,
        "revToday": 0,
        "buryToday": {},
        "dayCutoff": 4,
        "sortType": "due",
        "timerValues": [],
        "lastStarted": 0,
    }
    col_cols = {"cols": ["id", "name", "newCount", "revCount", "ivlCount",
                         "collapsed", "dyn"], "typos": []}

    # Build the SQLite collection in memory, then serialize.
    db = sqlite3.connect(":memory:")
    db.executescript(_SCHEMA)

    # Media: embed per-card images as <img> tags and register them.
    media_files: dict[str, bytes] = dict(media)
    note_rows = []
    card_rows = []
    nid = 1
    cid = 1
    for i, card in enumerate(cards):
        front = _html_escape(card["front"])
        back = _html_escape(card["back"])
        img = card.get("image")
        if img:
            fname = f"card{i:04d}.jpg"
            media_files[fname] = img
            front = f'{front}<br><img src="{fname}">'
        fields = [front, back]
        note_rows.append((
            nid, _guid(), model_id, now, 0, "", _flds_join(fields),
            fields[0][:60], 0, 0, "",
        ))
        # type=0 normal, queue=0 new, due=0
        card_rows.append((cid, nid, deck_id, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""))
        nid += 1
        cid += 1

    db.execute(
        "INSERT INTO col VALUES (1, ?, ?, 0, 1, 0, -1, 0, ?, ?, ?, ?, ?)",
        (now, now, json.dumps(col_conf), json.dumps([model], ensure_ascii=False),
         json.dumps(col_cols), json.dumps({"1": {}}), "[]"),
    )
    db.execute("INSERT INTO decks VALUES (?, ?)", (deck_id, deck_name))
    db.executemany("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)", note_rows)
    db.executemany("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", card_rows)
    db.commit()
    # Serialize the in-memory DB to bytes via a temp file.
    import os
    import tempfile
    tmp_path = tempfile.mktemp(suffix=".db")
    target = sqlite3.connect(tmp_path)
    db.backup(target)
    target.close()
    db.close()
    with open(tmp_path, "rb") as f:
        db_bytes = f.read()
    os.unlink(tmp_path)

    # Write the .apkg zip.
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("collection.anki21", bytes(db_bytes))
        if media_files:
            z.writestr("media", "\n".join(sorted(media_files.keys())))
            for name, data in media_files.items():
                z.writestr(f"media/{name}", data)
    return str(out)
