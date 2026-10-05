"""LLM-driven analysis and flashcard generation.

analyze()   -> topics, suggested card count, difficulty mix (one cheap pass)
generate()  -> grounded cards for a chunk of slides (strict JSON)

Both are pure functions over the parsed document so they are trivially
testable and resumable.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from ..llm import LLMClient
from .parse import ParsedDocument

log = logging.getLogger("studydeck.generate")


@dataclass
class GenerationConfig:
    topics: list[str] = field(default_factory=list)   # empty = all topics
    card_count: int = 30
    card_types: list[str] = field(default_factory=lambda: ["qa", "cloze", "mc"])
    difficulties: list[str] = field(default_factory=lambda: ["easy", "medium", "hard"])
    language: str = "de"
    images: bool = True          # attach figures where useful
    focus: str = ""              # free-text refinement ("mehr auf Chromatographie")

    def to_dict(self):
        return {
            "topics": self.topics, "card_count": self.card_count,
            "card_types": self.card_types, "difficulties": self.difficulties,
            "language": self.language, "images": self.images, "focus": self.focus,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "GenerationConfig":
        defaults = cls().to_dict()
        return cls(**{k: d.get(k, v) for k, v in defaults.items()})


def _slides_to_text(parsed: ParsedDocument, pages: list[int]) -> str:
    by_num = {s.number: s for s in parsed.slides}
    parts = []
    for n in pages:
        s = by_num.get(n)
        if s and s.text.strip():
            parts.append(f"[Folie {n}] {s.text}")
    return "\n\n".join(parts)


def _content_pages(parsed: ParsedDocument) -> list[int]:
    """Pages with real content (skip near-empty intro/section-divider slides)."""
    return [s.number for s in parsed.slides if len(s.text.strip()) >= 40]


def analyze(client: LLMClient, parsed: ParsedDocument) -> dict:
    """One pass over the document's slide titles/structure -> topics +
    suggested card count + difficulty mix."""
    # Use titles + first lines to keep the prompt compact.
    lines = []
    for s in parsed.slides:
        first = s.text.strip().split("\n", 1)[0][:100] if s.text.strip() else ""
        lines.append(f"Folie {s.number}: {s.title or first}")
    structure = "\n".join(lines)

    system = (
        "Du analysierst eine Vorlesung (Folienstruktur) und bereitest die "
        "Erstellung von Lernkarten vor. Antworte AUSSCHLIESSLICH mit gültigem JSON:\n"
        '{"course_title": "...", "topics": [{"name": "...", "slides": [1,2,3], '
        '"card_suggestion": 8, "difficulty": "easy|medium|hard"}], '
        '"suggested_card_count": 40, "summary": "2-3 Sätze zum Inhalt"}\n'
        "Regeln: 4-10 Themen, die die Folien vollständig abdecken. "
        "card_suggestion = sinnvolle Anzahl Lernkarten pro Thema (je nach Umfang/Dichte). "
        "suggested_card_count = Summe, auf 5 gerundet."
    )
    user = f"Folienstruktur der Vorlesung:\n\n{structure}"
    result = client.chat_json(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        model=settings_fast_model(), max_tokens=4000, temperature=0.2,
    )
    # Normalize
    topics = result.get("topics", [])
    for t in topics:
        t.setdefault("slides", [])
        t.setdefault("card_suggestion", 5)
        t.setdefault("difficulty", "medium")
    result["topics"] = topics
    result.setdefault("suggested_card_count", 30)
    result.setdefault("course_title", parsed.filename)
    result.setdefault("summary", "")
    return result


def settings_fast_model() -> str | None:
    from ..config import settings
    return settings.llm_model_fast or None


def _select_pages(parsed: ParsedDocument, config: GenerationConfig, analysis: dict) -> list[int]:
    """Pick the slides to draw cards from, based on selected topics."""
    all_pages = _content_pages(parsed)
    if not config.topics:
        return all_pages
    topic_slides: set[int] = set()
    for t in analysis.get("topics", []):
        if t.get("name") in config.topics:
            topic_slides.update(t.get("slides", []))
    pages = [p for p in all_pages if p in topic_slides]
    return pages or all_pages


def _chunk_pages(pages: list[int], max_chars: int = 14000) -> list[list[int]]:
    """Group consecutive pages into chunks under max_chars."""
    chunks: list[list[int]] = []
    cur: list[int] = []
    cur_len = 0
    for p in pages:
        size = _PAGE_SIZES.get(p, 300)
        if cur and cur_len + size > max_chars:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append(p)
        cur_len += size
    if cur:
        chunks.append(cur)
    return chunks


_PAGE_SIZES: dict[int, int] = {}


def _register_sizes(parsed: ParsedDocument) -> None:
    global _PAGE_SIZES
    _PAGE_SIZES = {s.number: max(100, len(s.text)) for s in parsed.slides}


CARDS_SYSTEM = """Du bist ein Experte für die Erstellung von Lernkarten (Flashcards) für Studierende.
Erstelle aus dem gegebenen Vorlesungstext präzise, prüfungsrelevante Lernkarten auf Deutsch.

Regeln:
- Jede Karte testet EINEN klaren Lerninhalt (Definition, Begriff, Formel, Zusammenhang, Verfahrensschritt, Abkürzung).
- Die Rückseite enthält die vollständige, korrekte Antwort.
- Bleibe strikt beim gegebenen Text. Erfinde nichts.
- Frage konkret, nicht vage ("Erkläre X" ist verboten).
- Nutze Foliennummern als Quelle (source_slides).
- needs_image=true WENN eine Abbildung/diagramm/Tabelle aus der Folie die Karte deutlich verbessert oder der Inhalt visuell ist (Schema, Chromatogramm, Tabelle, Aufbau, Diagramm, Kurve). Bei visuellem Folieninhalt (z.B. ein Chromatogramm oder eine Tabelle, die die Frage betrifft) setze needs_image=true. image_hint beschreibt dann die passende Abbildung kurz (was auf der Folie zu sehen ist). Setze needs_image=false nur wenn die Karte rein textbegrifflich ist.

Antworte AUSSCHLIESSLICH mit gültigem JSON:
{"cards": [
  {"front": "...", "back": "...", "type": "qa|cloze|mc", "topic": "Thema",
   "source_slides": [21], "difficulty": "easy|medium|hard",
   "needs_image": false, "image_hint": ""}
]}
- cloze: front ist ein Satz mit genau einer Lücke __________.
- mc: back hat die Form "Antwort: B) richtig | A) ... C) ... D) ..." (korrekte zuerst)."""


def generate_cards(
    client: LLMClient,
    parsed: ParsedDocument,
    config: GenerationConfig,
    analysis: dict,
    chunk_pages: list[int],
    target_count: int,
) -> list[dict]:
    """Generate cards for one chunk of pages, aiming at target_count cards."""
    _register_sizes(parsed)
    text = _slides_to_text(parsed, chunk_pages)
    if not text.strip():
        return []

    types = "/".join(config.card_types)
    diffs = "/".join(config.difficulties)
    focus = f"\nZusatzfokus vom Nutzer: {config.focus}" if config.focus else ""
    user = (
        f"Erstelle genau {target_count} Lernkarten aus diesem Vorlesungstext.\n"
        f"Erlaubte Kartentypen: {types}. Erlaubte Schwierigkeiten: {diffs}.{focus}\n\n"
        f"{text}"
    )
    result = client.chat_json(
        [{"role": "system", "content": CARDS_SYSTEM}, {"role": "user", "content": user}],
        max_tokens=12000,
    )
    cards = result.get("cards", [])
    # Validate + normalize
    out = []
    for c in cards:
        front = (c.get("front") or "").strip()
        back = (c.get("back") or "").strip()
        if not front or not back:
            continue
        ctype = c.get("type", "qa")
        if ctype not in ("qa", "cloze", "mc"):
            ctype = "qa"
        diff = c.get("difficulty", "medium")
        if diff not in ("easy", "medium", "hard"):
            diff = "medium"
        src = c.get("source_slides") or []
        src = [int(x) for x in src if str(x).isdigit()]
        out.append({
            "front": front,
            "back": back,
            "type": ctype,
            "topic": (c.get("topic") or "").strip(),
            "difficulty": diff,
            "source_slides": src,
            "needs_image": bool(c.get("needs_image", False)),
            "image_hint": (c.get("image_hint") or "").strip(),
        })
    return out


def plan_chunks(
    parsed: ParsedDocument, config: GenerationConfig, analysis: dict
) -> list[dict]:
    """Decide which page-chunks to generate and how many cards each should yield.

    Returns [{"pages": [...], "target": int}, ...]
    """
    pages = _select_pages(parsed, config, analysis)
    total_chars = sum(len(s.text) for s in parsed.slides if s.number in set(pages))
    n_chunks = max(1, min(6, round(total_chars / 14000)))
    chunks = _chunk_pages(pages, max_chars=14000)
    if len(chunks) > n_chunks:
        # Merge smallest chunks until we're at n_chunks.
        while len(chunks) > n_chunks:
            idx = min(range(len(chunks) - 1), key=lambda i: len(chunks[i]) + len(chunks[i + 1]))
            chunks[idx] = chunks[idx] + chunks[idx + 1]
            del chunks[idx + 1]
    # Distribute target count proportionally to chunk size.
    sizes = [sum(len(s.text) for s in parsed.slides if s.number in set(c)) for c in chunks]
    total = sum(sizes) or 1
    targets = [max(2, round(config.card_count * s / total)) for s in sizes]
    # Fix rounding drift.
    drift = config.card_count - sum(targets)
    if targets:
        targets[0] = max(1, targets[0] + drift)
    return [{"pages": c, "target": t} for c, t in zip(chunks, targets)]
