"""PDF parsing: text, layout detection, slides/sections, figure candidates.

Two layout families:
  * "slide" — PowerPoint-derived PDFs where each page is a self-contained
    concept unit. Chunking = per page.
  * "book"  — continuous prose. Chunking = by heading/section with overlap.

Figure candidates are recorded per page as bounding boxes; the FIGURES stage
decides which to crop and how (raster image vs. page-region render for
vector-drawn figures).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pymupdf

from ..config import settings

log = logging.getLogger("studydeck.parse")


@dataclass
class FigureCandidate:
    page: int            # 1-based
    kind: str            # "raster" | "vector"
    bbox: list[float]    # [x0, y0, x1, y1]
    width: int
    height: int
    area_frac: float

    def to_dict(self):
        return asdict(self)


@dataclass
class Slide:
    number: int          # 1-based page number
    title: str
    text: str
    figures: list[FigureCandidate] = field(default_factory=list)


@dataclass
class ParsedDocument:
    doc_id: str
    filename: str
    layout: str
    page_count: int
    slides: list[Slide] = field(default_factory=list)
    sections: list[dict] = field(default_factory=list)  # for book layout
    toc: list[list] = field(default_factory=list)

    def to_dict(self):
        return {
            "doc_id": self.doc_id,
            "filename": self.filename,
            "layout": self.layout,
            "page_count": self.page_count,
            "toc": self.toc,
            "sections": self.sections,
            "slides": [
                {
                    "number": s.number,
                    "title": s.title,
                    "text": s.text,
                    "figures": [f.to_dict() for f in s.figures],
                }
                for s in self.slides
            ],
        }


def _looks_like_slide_deck(doc: pymupdf.Document) -> bool:
    """Heuristic: PowerPoint-exported PDFs have a TOC entry per page and
    short, self-contained page text. We trust the TOC shape first."""
    toc = doc.get_toc()
    if len(toc) >= max(5, int(0.8 * len(doc))):
        # Nearly every page is an outline entry -> slide deck.
        return True
    # Fallback: creator metadata says PowerPoint/Keynote.
    creator = (doc.metadata.get("creator") or "").lower()
    if "powerpoint" in creator or "keynote" in creator:
        return True
    # Fallback: median page text is short.
    lengths = [len(p.get_text("text").strip()) for p in doc]
    if lengths:
        median = sorted(lengths)[len(lengths) // 2]
        if median < 400:
            return True
    return False


def _slide_title(text: str) -> str:
    """First non-trivial line of a slide as its title."""
    for line in text.splitlines():
        line = line.strip()
        if line and not re.fullmatch(r"\d{1,3}", line) and len(line) > 3:
            # Skip running headers that repeat the course code.
            return line[:120]
    return ""


def _figures_on_page(page: pymupdf.Page) -> list[FigureCandidate]:
    """Find figure candidates: sizable raster images, plus the page's main
    drawing region (for vector figures)."""
    pw, ph = page.rect.width, page.rect.height
    out: list[FigureCandidate] = []
    seen_boxes: list[tuple] = []

    for img in page.get_image_info():
        b = img["bbox"]
        w, h = b[2] - b[0], b[3] - b[1]
        area = (w * h) / (pw * ph)
        if area > 0.03 and w > 60 and h > 60:
            out.append(FigureCandidate(page=0, kind="raster", bbox=[round(v, 1) for v in b],
                                       width=int(w), height=int(h), area_frac=round(area, 3)))
            seen_boxes.append(b)

    # Vector figures: union of drawing bboxes that form a large cluster.
    drawings = page.get_drawings()
    if drawings:
        rects = [d["rect"] for d in drawings if d.get("rect")]
        if rects:
            # Union bounding box of all vector art.
            x0 = min(r.x0 for r in rects); y0 = min(r.y0 for r in rects)
            x1 = max(r.x1 for r in rects); y1 = max(r.y1 for r in rects)
            w, h = x1 - x0, y1 - y0
            area = (w * h) / (pw * ph)
            # A figure can't be (nearly) the whole page — that's the slide
            # frame/border, not a figure. Reject near-full-page unions.
            full_page = area > 0.85
            # Only if it's a substantial region and not already covered by a raster.
            if area > 0.08 and w > 100 and h > 100 and not full_page:
                overlaps_raster = any(
                    _overlap_frac((x0, y0, x1, y1), b) > 0.7 for b in seen_boxes
                )
                if not overlaps_raster:
                    out.append(FigureCandidate(page=0, kind="vector",
                                               bbox=[round(x0, 1), round(y0, 1),
                                                     round(x1, 1), round(y1, 1)],
                                               width=int(w), height=int(h),
                                               area_frac=round(area, 3)))
    for f in out:
        f.page = page.number + 1
    return out


def _overlap_frac(a, b) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix = max(0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0, min(ay1, by1) - max(ay0, by0))
    inter = ix * iy
    area_a = (ax1 - ax0) * (ay1 - ay0)
    return inter / area_a if area_a else 0.0


def parse_document(doc_id: str, filename: str, stored_path: str) -> ParsedDocument:
    path = Path(stored_path)
    doc = pymupdf.open(str(path))
    layout = "slide" if _looks_like_slide_deck(doc) else "book"
    toc = doc.get_toc()

    parsed = ParsedDocument(doc_id=doc_id, filename=filename, layout=layout,
                            page_count=len(doc), toc=toc)

    if layout == "slide":
        for page in doc:
            text = page.get_text("text").strip()
            parsed.slides.append(Slide(
                number=page.number + 1,
                title=_slide_title(text),
                text=text,
                figures=_figures_on_page(page),
            ))
    else:
        # Book layout: keep per-page text too (simpler + robust), and record
        # headings from the TOC as section anchors.
        for page in doc:
            text = page.get_text("text").strip()
            parsed.slides.append(Slide(
                number=page.number + 1,
                title=_slide_title(text),
                text=text,
                figures=_figures_on_page(page),
            ))
        parsed.sections = [
            {"title": t[1], "page": t[2], "level": t[0]} for t in toc
        ]

    log.info("parsed %s: layout=%s pages=%d slides=%d",
             filename, layout, len(doc), len(parsed.slides))
    return parsed


def save_parsed(parsed: ParsedDocument) -> str:
    """Persist the parse result as JSON next to the data dir; returns path."""
    out = settings.data_dir / "parsed" / f"{parsed.doc_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(parsed.to_dict(), ensure_ascii=False), encoding="utf-8")
    return str(out)


def load_parsed(doc_id: str) -> ParsedDocument | None:
    p = settings.data_dir / "parsed" / f"{doc_id}.json"
    if not p.exists():
        return None
    raw = json.loads(p.read_text(encoding="utf-8"))
    # Reconstruct Slide/FigureCandidate dataclasses from their JSON dicts so
    # consumers can use attribute access (s.text, s.number, s.figures...).
    slides = []
    for s in raw.get("slides", []):
        figs = [
            FigureCandidate(
                page=f.get("page", 0), kind=f.get("kind", "raster"),
                bbox=f.get("bbox", [0, 0, 0, 0]), width=f.get("width", 0),
                height=f.get("height", 0), area_frac=f.get("area_frac", 0.0),
            )
            for f in s.get("figures", [])
        ]
        slides.append(Slide(number=s.get("number", 0), title=s.get("title", ""),
                            text=s.get("text", ""), figures=figs))
    return ParsedDocument(
        doc_id=raw.get("doc_id", doc_id), filename=raw.get("filename", ""),
        layout=raw.get("layout", "slide"), page_count=raw.get("page_count", 0),
        slides=slides, sections=raw.get("sections", []), toc=raw.get("toc", []),
    )
