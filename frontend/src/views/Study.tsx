import { useCallback, useEffect, useState } from "react";
import { api, Card, figureUrl } from "../api";
import { clozeMatches, parseCloze, parseMc } from "../cardContent";

// The 4 FSRS rating levels (backend expects 1–4).
const RATINGS: { value: number; label: string }[] = [
  { value: 1, label: "Wiederholen" },
  { value: 2, label: "Schwer" },
  { value: 3, label: "Gut" },
  { value: 4, label: "Leicht" },
];

interface Props {
  onRefresh: () => void;
}

export default function Study({ onRefresh }: Props) {
  const [queue, setQueue] = useState<Card[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);

  // Per-card interaction state (reset when the card changes).
  const [mcChoice, setMcChoice] = useState<string | null>(null);
  const [clozeInput, setClozeInput] = useState("");

  const card = queue[idx];

  const mc = card && card.type === "mc" ? parseMc(card.back) : null;
  const cloze =
    card && card.type === "cloze" ? parseCloze(card.front, card.back) : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setQueue(await api.dueCards(undefined, undefined, 100));
      setIdx(0);
      setDone(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset interaction state whenever we move to a new card.
  useEffect(() => {
    setRevealed(false);
    setMcChoice(null);
    setClozeInput("");
  }, [idx, queue]);

  const rate = async (rating: number) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await api.reviewCard(card.id, rating);
      setDone((d) => d + 1);
      const next = queue.filter((_, i) => i !== idx);
      setQueue(next);
      setIdx(next.length === 0 ? 0 : Math.min(idx, next.length - 1));
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="muted">Lade fällige Karten…</p>;
  if (error && queue.length === 0) return <div className="error">{error}</div>;
  if (queue.length === 0)
    return (
      <div className="card" style={{ textAlign: "center", padding: "40px 0" }}>
        <h2>Alles erledigt 🎉</h2>
        <p className="muted">
          Keine fälligen Karten mehr
          {done > 0 ? ` – ${done} gelernt in dieser Runde` : ""}.
        </p>
        <button className="primary mt" onClick={() => void load()}>
          Erneut prüfen
        </button>
      </div>
    );

  const correct = mc && mcChoice ? mcChoice === mc.correctLetter : null;

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1 style={{ margin: 0 }}>
          Karte {idx + 1} / {queue.length}
        </h1>
        <span className="pill">{card?.type.toUpperCase()}</span>
      </div>

      <div className="flashcard">
        <div className="front">{card?.front}</div>

        {/* Multiple choice: selectable options before reveal */}
        {mc && !revealed && (
          <div className="mc-options">
            {mc.options.map((o) => (
              <button
                key={o.letter}
                className={`mc-option ${mcChoice === o.letter ? "selected" : ""}`}
                onClick={() => setMcChoice(o.letter)}
              >
                <span className="mc-letter">{o.letter}</span>
                <span>{o.text}</span>
              </button>
            ))}
          </div>
        )}

        {/* Cloze: fill in the blank before reveal */}
        {cloze && !revealed && (
          <input
            className="cloze-input"
            type="text"
            placeholder="Deine Antwort…"
            value={clozeInput}
            onChange={(e) => setClozeInput(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        )}

        {/* Reveal / feedback */}
        {revealed && (
          <div className="back">
            {mc && (
              <div>
                {mcChoice && (
                  <p className={correct ? "good" : "bad"}>
                    {correct
                      ? "✓ Richtig!"
                      : `✗ Falsch – richtig ist ${mc.correctLetter}.`}
                  </p>
                )}
                <div className="mc-options">
                  {mc.options.map((o) => (
                    <div
                      key={o.letter}
                      className={`mc-option static ${
                        o.letter === mc.correctLetter
                          ? "correct"
                          : mcChoice === o.letter
                          ? "wrong"
                          : ""
                      }`}
                    >
                      <span className="mc-letter">{o.letter}</span>
                      <span>{o.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cloze && (
              <div>
                {clozeInput.trim() && (
                  <p className={clozeMatches(clozeInput, cloze) ? "good" : "bad"}>
                    {clozeMatches(clozeInput, cloze)
                      ? "✓ Richtig!"
                      : `✗ Deine Antwort: ${clozeInput}`}
                  </p>
                )}
                <p>
                  {cloze.before}
                  <strong className="cloze-answer">{cloze.core}</strong>
                  {cloze.after}
                </p>
                {cloze.explanation && (
                  <p className="muted">{cloze.explanation}</p>
                )}
              </div>
            )}

            {!mc && !cloze && <div>{card?.back}</div>}

            {card?.image_path && (
              <img
                src={figureUrl(card.image_path) ?? undefined}
                alt=""
                loading="lazy"
              />
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {!revealed ? (
        <button className="primary mt" onClick={() => setRevealed(true)}>
          {mc ? "Antwort prüfen" : "Antwort zeigen"}
        </button>
      ) : (
        <div className="rating-bar mt">
          {RATINGS.map((r, i) => (
            <button
              key={r.value}
              className={`rating rating-${r.value - 1}`}
              disabled={busy}
              onClick={() => void rate(r.value)}
            >
              <span className="rating-label">{r.label}</span>
              <span className="rating-key">{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="error mt">{error}</div>}
    </div>
  );
}
