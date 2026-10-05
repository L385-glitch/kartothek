"""Figure extraction: turn a card's image need into a real file.

Two paths (validated in the Phase-0 spike):
  1. raster  — crop the largest matching raster image on the source page.
  2. vector  — render the page's main drawing region (for vector-drawn
               figures like tables/schematics that aren't raster images).

Matching: the card lists source pages + a free-text image_hint. We score
each figure candidate on the source pages by size and (weakly) by whether
the hint words appear in nearby slide text. The best candidate wins; if a
card needs an image but nothing decent exists, we fall back to rendering
the whole content region of the primary source page.
"""
from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

import pymupdf

from ..config import settings
from .parse import ParsedDocument

log = logging.getLogger("kartothek.figures")


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:60] or "fig"


def _content_rect(page: pymupdf.Page) -> pymupdf.Rect:
    """Bounding box of the page's text+drawings (excludes margins/logos)."""
    blocks = page.get_text("blocks")
    rects = [pymupdf.Rect(b[:4]) for b in blocks if b[6] == 0]  # text blocks
    for d in page.get_drawings():
        r = d.get("rect")
        if r:
            rects.append(pymupdf.Rect(r))
    if not rects:
        return page.rect
    x0 = min(r.x0 for r in rects); y0 = min(r.y0 for r in rects)
    x1 = max(r.x1 for r in rects); y1 = max(r.y1 for r in rects)
    # Trim top/bottom running headers/footers (logo + slide number).
    pad = 0.06
    y0 = max(y0, page.rect.y0 + page.rect.height * pad)
    y1 = min(y1, page.rect.y1 - page.rect.height * pad * 0.5)
    return pymupdf.Rect(x0, y0, x1, y1) & page.rect


def _score_candidate(cand: dict, hint: str, slide_text: str) -> float:
    score = cand.get("area_frac", 0)
    if hint:
        hint_words = [w for w in re.findall(r"[a-zäöüß0-9]{4,}", hint.lower())]
        text_l = slide_text.lower()
        hits = sum(1 for w in hint_words if w in text_l)
        if hint_words:
            score += 0.3 * (hits / len(hint_words))
    if cand.get("kind") == "raster":
        score += 0.1
    return score


def attach_figure(
    doc_path: str,
    parsed: ParsedDocument,
    card: dict,
    deck_id: str,
    card_index: int,
) -> str | None:
    """Produce an image for a card; returns the stored relative path or None."""
    if not card.get("needs_image"):
        return None

    pages = card.get("source_slides") or []
    if not pages:
        return None
    hint = card.get("image_hint", "")
    by_num = {s.number: s for s in parsed.slides}

    doc = pymupdf.open(doc_path)
    best = None  # (score, kind, page, bbox)
    for p in pages:
        slide = by_num.get(p)
        text = slide.text if slide else ""
        for cand in (slide.figures if slide else []):
            score = _score_candidate(
                {"area_frac": cand.area_frac, "kind": cand.kind}, hint, text
            )
            if best is None or score > best[0]:
                best = (score, cand.kind, p, cand.bbox)

    out_dir = settings.figures_dir / deck_id
    out_dir.mkdir(parents=True, exist_ok=True)

    if best is not None:
        score, kind, p, bbox = best
        page = doc[p - 1]
        clip = pymupdf.Rect(bbox)
        clip = clip + (-6, -6, 6, 6)
        clip = clip & page.rect
        # Only an icon-sized box is useless on its own -> render the content
        # region instead. A genuine inset figure (a few % of the page) is
        # cropped as-is, since that IS the figure.
        if clip.width * clip.height < 0.015 * page.rect.width * page.rect.height:
            clip = _content_rect(page)
        dpi = 200 if clip.width * clip.height < 0.15 * page.rect.width * page.rect.height else 150
        pix = page.get_pixmap(dpi=dpi, clip=clip)
    else:
        # No candidate: render the content region of the first source page.
        page = doc[pages[0] - 1]
        clip = _content_rect(page)
        pix = page.get_pixmap(dpi=150, clip=clip)

    # Name the file deterministically from content so re-runs dedupe.
    digest = hashlib.sha256(pix.tobytes("png")).hexdigest()[:12]
    rel = f"{deck_id}/{_slug(card.get('topic', ''))}_{card_index}_{digest}.png"
    out_path = settings.figures_dir / rel
    pix.save(str(out_path))
    log.info("figure for card %d (%s): %s (%dx%d)", card_index, card.get("topic"), rel,
             pix.width, pix.height)
    return rel
