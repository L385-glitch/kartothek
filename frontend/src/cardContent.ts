// Parsers for the interactive card types (MC + cloze).
//
// The LLM emits these in free text, so the formats are not perfectly
// consistent. We parse defensively and fall back to plain-text rendering
// (the old behaviour) whenever a card doesn't match the expected shape.

export interface McOption {
  letter: string; // "A" | "B" | "C" | "D"
  text: string;
}

export interface McCard {
  correctLetter: string;
  options: McOption[];
}

export interface ClozeCard {
  before: string;
  after: string;
  answer: string; // full answer text (for reveal)
  core: string; // answer without a trailing parenthetical explanation
  explanation?: string;
}

const LETTERS = ["A", "B", "C", "D"];

// Parse an MC card's back ("Antwort: B) ... | A) ... | C) ... | D) ...")
// into ordered options + the correct letter. Returns null if unparseable.
export function parseMc(back: string): McCard | null {
  const head = back.match(/^Antwort:\s*([A-Da-d])(?:\))?/);
  if (!head) return null;
  const correctLetter = head[1].toUpperCase();

  // Locate every "L)" option marker.
  const markerRe = /([A-Da-d])\)/g;
  const marks: { letter: string; markerStart: number; textStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(back)) !== null) {
    marks.push({
      letter: m[1].toUpperCase(),
      markerStart: m.index,
      textStart: m.index + m[0].length,
    });
  }
  if (marks.length < 2) return null;

  const byLetter = new Map<string, string>();
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].markerStart : back.length;
    let text = back.slice(mk.textStart, end);
    // Collapse separator pipes and whitespace.
    text = text.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim();
    if (!byLetter.has(mk.letter)) byLetter.set(mk.letter, text);
  });

  const options = LETTERS.filter((l) => byLetter.has(l)).map((l) => ({
    letter: l,
    text: byLetter.get(l)!,
  }));
  if (options.length < 2) return null;
  return { correctLetter, options };
}

// Parse a cloze card: front contains the blank, back holds the answer.
// Returns null if the front has no recognisable blank.
export function parseCloze(front: string, back: string): ClozeCard | null {
  const blank = front.match(/_{4,}|\u2026{2,}|\[\s*\]/);
  if (!blank) return null;
  const idx = blank.index!;
  const before = front.slice(0, idx).replace(/\s+$/, "");
  const after = front.slice(idx + blank[0].length).replace(/^\s+/, "");

  const answer = back.trim();
  // Split a trailing parenthetical explanation: "Antwort (Erläuterung)"
  const paren = answer.match(/^(.*?)\s*[（(]\s*([^()（）]+?)\s*[)）]\s*$/);
  const core = paren ? paren[1].trim() : answer;
  const explanation = paren ? paren[2].trim() : undefined;
  return { before, after, answer, core, explanation };
}

// Normalise text for lenient cloze answer matching.
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.\s]+/g, " ")
    .trim();
}

// Does a user's cloze input match the answer (core or full)?
export function clozeMatches(input: string, card: ClozeCard): boolean {
  const n = normalise(input);
  if (!n) return false;
  return n === normalise(card.core) || n === normalise(card.answer);
}
