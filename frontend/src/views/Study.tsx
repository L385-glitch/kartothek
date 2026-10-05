import { useEffect, useState } from "react";
import { api, Card, figureUrl } from "../api";

interface Props {
  onRefresh: () => void;
}

const RATINGS = [
  { v: 1, label: "Wiederholen", cls: "danger" },
  { v: 2, label: "Schwer", cls: "" },
  { v: 3, label: "Gut", cls: "primary" },
  { v: 4, label: "Leicht", cls: "ok" },
] as const;

export default function Study({ onRefresh }: Props) {
  const [queue, setQueue] = useState<Card[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const due = await api.dueCards(undefined, undefined, 100);
      setQueue(due);
      setIdx(0);
      setRevealed(false);
      setDone(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = queue[idx];

  const rate = async (rating: number) => {
    if (!current) return;
    try {
      await api.reviewCard(current.id, rating);
    } catch (e) {
      setError(String(e));
    }
    setDone((d) => d + 1);
    onRefresh();
    if (idx + 1 >= queue.length) {
      setRevealed(false);
      load();
    } else {
      setIdx((i) => i + 1);
      setRevealed(false);
    }
  };

  if (loading) return <p className="muted">Lade fällige Karten…</p>;

  if (error) return <div className="error">{error}</div>;

  if (queue.length === 0) {
    return (
      <div className="stagger">
        <h1>Lernen</h1>
        <div className="card">
          <div style={{ fontSize: 40, textAlign: "center" }}>🎉</div>
          <h2 style={{ textAlign: "center" }}>Alles erledigt!</h2>
          <p className="muted" style={{ textAlign: "center" }}>
            Keine fälligen Karten. Erstelle neue über „Neue Karten erstellen“ oder
            prüfe freigegebene Karten im Lern-Hub.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1>Lernen</h1>
        <span className="muted">
          {idx + 1} / {queue.length} · {done} bewertet
        </span>
      </div>

      <div className="progress mb">
        <div style={{ width: `${(idx / queue.length) * 100}%` }} />
      </div>

      {current && (
        <div className="flashcard" key={current.id}>
          <div className="front">{current.front}</div>
          {current.image_path && (
            <img src={figureUrl(current.image_path) ?? undefined} alt="" />
          )}
          {revealed && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid var(--border)" }} />
              <div className="back">{current.back}</div>
            </>
          )}
        </div>
      )}

      <div className="row mt" style={{ justifyContent: "center", gap: 10 }}>
        {!revealed ? (
          <button className="primary" onClick={() => setRevealed(true)}>
            Antwort zeigen
          </button>
        ) : (
          RATINGS.map((r) => (
            <button
              key={r.v}
              className={r.cls === "danger" ? "danger" : r.cls}
              onClick={() => rate(r.v)}
            >
              {r.label}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
