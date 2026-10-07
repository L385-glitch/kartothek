"""LLM-driven mock-exam generation and grading.

generate_exam() -> a list of questions grounded in one or more parsed
                  documents (strict JSON).
grade_attempt() -> per-question grading + feedback (strict JSON).

Both are pure functions over the parsed document(s) so they are trivially
testable and resumable. They mirror the conventions in generate.py.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from ..llm import LLMClient, LLMError
from .parse import ParsedDocument

log = logging.getLogger("studydeck.exam")

# Question types the exam can contain.
QUESTION_TYPES = ("mc", "short", "long")


@dataclass
class ExamConfig:
    kind: str = "exam"                 # "exam" | "exercise"
    question_count: int = 12
    question_types: list[str] = field(default_factory=lambda: ["mc", "short", "long"])
    difficulties: list[str] = field(default_factory=lambda: ["easy", "medium", "hard"])
    focus: str = ""                    # free-text refinement
    language: str = "de"

    def to_dict(self) -> dict:
        return {
            "kind": self.kind, "question_count": self.question_count,
            "question_types": self.question_types,
            "difficulties": self.difficulties, "focus": self.focus,
            "language": self.language,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ExamConfig":
        defaults = cls().to_dict()
        return cls(**{k: d.get(k, v) for k, v in defaults.items()})


# ---- document -> text -----------------------------------------------------

def _slides_to_text(parsed: ParsedDocument, pages: list[int] | None = None) -> str:
    """Concatenate the given pages (all if None) with slide markers."""
    by_num = {s.number: s for s in parsed.slides}
    nums = pages if pages is not None else [s.number for s in parsed.slides]
    parts = []
    for n in nums:
        s = by_num.get(n)
        if s and s.text.strip():
            parts.append(f"[Folie {n}] {s.text}")
    return "\n\n".join(parts)


def _content_pages(parsed: ParsedDocument) -> list[int]:
    return [s.number for s in parsed.slides if len(s.text.strip()) >= 40]


def _chunk_pages(pages: list[int], parsed: ParsedDocument, max_chars: int = 14000) -> list[list[int]]:
    """Group consecutive pages into chunks under max_chars."""
    sizes = {s.number: max(100, len(s.text)) for s in parsed.slides}
    chunks: list[list[int]] = []
    cur: list[int] = []
    cur_len = 0
    for p in pages:
        size = sizes.get(p, 300)
        if cur and cur_len + size > max_chars:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append(p)
        cur_len += size
    if cur:
        chunks.append(cur)
    return chunks


def _all_content_text(parsed: ParsedDocument) -> str:
    """Full document text (for grading, where we want the whole source)."""
    return _slides_to_text(parsed, _content_pages(parsed))


# ---- generation -----------------------------------------------------------

EXAM_SYSTEM = """Du bist ein erfahrener Prüfungsautor für ein Studium (Umwelttechnik/Schweiz).
Erstelle aus dem gegebenen Vorlesungstext eine Prüfung (oder Übungsblatt) auf Deutsch.

Regeln:
- Jede Aufgabe testet EINEN klaren, prüfungsrelevanten Lerninhalt aus dem Text.
- Bleibe strikt beim gegebenen Text. Erfinde nichts.
- Verteile die Aufgaben über die Themen des Dokuments.
- Punkte (points) pro Aufgabe: mc=1-2, short=2-3, long=4-6.
- Für mc: genau 4 Optionen A-D, genau eine korrekt (correct_index = 0-basiert),
  die anderen plausibel aber falsch.
- Für short/long: answer_key = eine präzise Musterlösung; explanation = kurze
  Erläuterung, warum die Antwort stimmt (dient als Korrekturnachricht).

Antworte AUSSCHLIESSLICH mit gültigem JSON:
{"questions": [
  {"id": "q1", "type": "mc", "text": "...", "points": 2,
   "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "correct_index": 1,
   "answer_key": "", "explanation": "...", "source_pages": [21]},
  {"id": "q2", "type": "short", "text": "...", "points": 3,
   "options": [], "correct_index": -1, "answer_key": "...",
   "explanation": "...", "source_pages": [22]},
  {"id": "q3", "type": "long", "text": "...", "points": 5,
   "options": [], "correct_index": -1, "answer_key": "...",
   "explanation": "...", "source_pages": [23]}
]}
- id = q1, q2, ... in der Reihenfolge.
- source_pages = Foliennummern, aus denen die Aufgabe stammt."""


def _normalize_question(q: dict, idx: int) -> dict | None:
    qid = q.get("id") or f"q{idx + 1}"
    text = (q.get("text") or "").strip()
    if not text:
        return None
    qtype = q.get("type", "short")
    if qtype not in QUESTION_TYPES:
        qtype = "short"
    try:
        points = int(q.get("points", 2))
    except (TypeError, ValueError):
        points = 2
    points = max(1, min(10, points))
    out = {
        "id": qid, "type": qtype, "text": text, "points": points,
        "options": [], "correct_index": -1,
        "answer_key": (q.get("answer_key") or "").strip(),
        "explanation": (q.get("explanation") or "").strip(),
        "source_pages": [int(x) for x in (q.get("source_pages") or []) if str(x).isdigit()],
    }
    if qtype == "mc":
        opts = [str(o).strip() for o in (q.get("options") or []) if str(o).strip()]
        if len(opts) < 2:
            return None
        ci = q.get("correct_index", 0)
        try:
            ci = int(ci)
        except (TypeError, ValueError):
            ci = 0
        if not (0 <= ci < len(opts)):
            ci = 0
        out["options"] = opts
        out["correct_index"] = ci
    return out


def generate_exam(
    client: LLMClient,
    parsed: ParsedDocument,
    config: ExamConfig,
) -> list[dict]:
    """Generate exam questions from a single parsed document, chunked by size."""
    pages = _content_pages(parsed)
    if not pages:
        return []
    chunks = _chunk_pages(pages, parsed, max_chars=14000)
    total = sum(sum(len(s.text) for s in parsed.slides if s.number in set(c)) for c in chunks)
    total = total or 1
    # Distribute the target count across chunks proportionally.
    sizes = [sum(len(s.text) for s in parsed.slides if s.number in set(c)) for c in chunks]
    targets = [max(1, round(config.question_count * s / total)) for s in sizes]
    drift = config.question_count - sum(targets)
    if targets:
        targets[0] = max(1, targets[0] + drift)

    types = "/".join(config.question_types)
    diffs = "/".join(config.difficulties)
    focus = f"\nZusatzfokus vom Nutzer: {config.focus}" if config.focus else ""
    kind_label = "Prüfung" if config.kind == "exam" else "Übungsblatt"

    all_questions: list[dict] = []
    for i, (chunk, target) in enumerate(zip(chunks, targets)):
        text = _slides_to_text(parsed, chunk)
        if not text.strip():
            continue
        user = (
            f"Erstelle genau {target} Aufgaben für eine {kind_label} aus diesem Vorlesungstext.\n"
            f"Erlaubte Aufgabentypen: {types}. Erlaubte Schwierigkeiten: {diffs}.{focus}\n\n"
            f"{text}"
        )
        result = client.chat_json(
            [{"role": "system", "content": EXAM_SYSTEM}, {"role": "user", "content": user}],
            max_tokens=12000,
        )
        raw = result.get("questions", []) if isinstance(result, dict) else []
        for j, q in enumerate(raw):
            nq = _normalize_question(q, len(all_questions) + j)
            if nq:
                all_questions.append(nq)

    # Cap at the requested count (trim from the end).
    if config.question_count > 0 and len(all_questions) > config.question_count:
        all_questions = all_questions[:config.question_count]
    return all_questions


# ---- grading --------------------------------------------------------------

GRADE_SYSTEM = """Du korrigierst die Antworten eines Studierenden auf Deutsch und gibst konstruktives Feedback.
Bewerte jede Aufgabe einzeln anhand der Musterlösung (answer_key) und des Vorlesungstextes.

Regeln:
- mc: korrekt, wenn die gewählte Option genau der richtigen entspricht.
- short/long: gib volle Punkte nur bei inhaltlich vollständiger und korrekter Antwort;
  halbe Punkte bei teilweise richtiger Antwort; 0 bei falscher/leerer Antwort.
- feedback = 1-3 Sätze: was stimmt, was fehlt, was verbessert werden sollte.
- Sei fair, aber präzise. Bleibe beim Vorlesungstext.

Antworte AUSSCHLIESSLICH mit gültigem JSON:
{"grading": [
  {"id": "q1", "correct": true, "points": 2, "max_points": 2, "feedback": "..."},
  {"id": "q2", "correct": false, "points": 1, "max_points": 3, "feedback": "..."}
]}
- id muss der Aufgaben-id entsprechen. points <= max_points, points >= 0."""


def grade_attempt(
    client: LLMClient,
    parsed: ParsedDocument,
    questions: list[dict],
    answers: dict,
    resubmit_note: str = "",
) -> list[dict]:
    """Grade a set of answers against the exam's questions + source text.

    answers maps question id -> the user's answer (a letter for mc, free
    text for short/long). Returns a list of grading dicts aligned to the
    questions, each with {id, correct, points, max_points, feedback}.
    """
    # Build a compact answer sheet.
    lines = []
    for q in questions:
        ans = answers.get(q["id"], "")
        if q["type"] == "mc":
            # Show the chosen option text if the user picked a letter.
            letter = str(ans).strip().upper()[:1]
            chosen = ""
            if letter and q["options"]:
                idx = ord(letter) - ord("A")
                if 0 <= idx < len(q["options"]):
                    chosen = q["options"][idx]
            lines.append(f'{q["id"]} ({q["type"]}, {q["points"]} Pkt): {q["text"]}\n'
                         f'  Musterlösung: {q["options"][q["correct_index"]] if q["options"] else q["answer_key"]}\n'
                         f'  Studierende Antwort: {letter or "(leer)"} {chosen}')
        else:
            lines.append(f'{q["id"]} ({q["type"]}, {q["points"]} Pkt): {q["text"]}\n'
                         f'  Musterlösung: {q["answer_key"]}\n'
                         f'  Erklärung: {q["explanation"]}\n'
                         f'  Studierende Antwort: {str(ans).strip() or "(leer)"}')
    sheet = "\n\n".join(lines)

    source = _all_content_text(parsed)
    # Keep the source prompt bounded — the grading model needs the context but
    # a 200-page lecture is overkill; cap to the pages the questions cite.
    cited: set[int] = set()
    for q in questions:
        cited.update(q.get("source_pages") or [])
    if cited:
        source = _slides_to_text(parsed, sorted(cited))
    if len(source) > 24000:
        source = source[:24000]

    note = f"\n\nDer Studierende hat zusätzlich erklärt: {resubmit_note}" if resubmit_note.strip() else ""
    user = (
        "Korrigiere die folgenden Antworten.\n\n"
        f"Vorlesungstext (Quelle):\n\n{source}\n\n"
        f"Antworten:\n\n{sheet}{note}"
    )
    result = client.chat_json(
        [{"role": "system", "content": GRADE_SYSTEM}, {"role": "user", "content": user}],
        max_tokens=8000,
    )
    raw = result.get("grading", []) if isinstance(result, dict) else []
    by_id = {g.get("id"): g for g in raw if isinstance(g, dict)}

    out = []
    for q in questions:
        g = by_id.get(q["id"], {})
        max_points = q["points"]
        try:
            points = int(g.get("points", 0))
        except (TypeError, ValueError):
            points = 0
        points = max(0, min(max_points, points))
        correct = bool(g.get("correct", points >= max_points))
        feedback = str(g.get("feedback") or "").strip()
        out.append({
            "id": q["id"], "correct": correct, "points": points,
            "max_points": max_points, "feedback": feedback,
        })
    return out
