import { useEffect, useState } from "react";
import { api, Card, figureUrl } from "../api";

interface Props {
  deckId: string;
  onDone: () => void;
  onRefresh: () => void;
}

export default function Review({ deckId, onDone, onRefresh }: Props) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"draft" | "approved" | "all">("draft");

  const load = async () => {
    try {
      const c = await api.listCards(deckId, filter === "all" ? undefined : filter);
      setCards(c);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, filter]);

  const approve = async (c: Card) => {
    await api.approveCard(c.id);
    onRefresh();
    load();
  };
  const reject = async (c: Card) => {
    await api.rejectCard(c.id);
    onRefresh();
    load();
  };
  const remove = async (c: Card) => {
    if (!confirm("Karte löschen?")) return;
    await api.deleteCard(c.id);
    onRefresh();
    load();
  };
  const approveAll = async () => {
    const r = await api.approveAll(deckId);
    alert(`${r.approved} Karten freigegeben.`);
    onRefresh();
    load();
  };

  const edit = (c: Card, field: "front" | "back" | "topic", value: string) => {
    api.updateCard(c.id, { [field]: value });
    setCards((prev) => prev.map((x) => (x.id === c.id ? { ...x, [field]: value } : x)));
  };

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1>Karten prüfen</h1>
        <div className="row">
          <select value={filter} onChange={(e) => setFilter(e.target.value as never)} style={{ width: 150 }}>
            <option value="draft">Entwürfe</option>
            <option value="approved">Freigegeben</option>
            <option value="all">Alle</option>
          </select>
          <button onClick={approveAll} disabled={filter !== "draft"}>
            Alle freigeben
          </button>
          <button onClick={onDone}>Fertig</button>
        </div>
      </div>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}
      {loading && <p className="muted">Lade…</p>}

      {cards.length === 0 && !loading && (
        <p className="muted">Keine Karten in dieser Ansicht.</p>
      )}

      {cards.map((c) => (
        <div className="review-card" key={c.id}>
          <div className="q">{c.front}</div>
          <div className="a">{c.back}</div>
          {c.image_path && (
            <img src={figureUrl(c.image_path) ?? undefined} alt="" loading="lazy" />
          )}
          <div className="meta">
            <span className="pill">{c.type}</span>
            <span className={`pill ${c.difficulty}`}>{c.difficulty}</span>
            <span className="pill">{c.topic || "—"}</span>
            {c.source_pages.length > 0 && (
              <span className="muted">Folien {c.source_pages.join(", ")}</span>
            )}
            <span className={`pill ${c.status === "approved" ? "ready" : "draft"}`}>
              {c.status === "approved" ? "freigegeben" : "Entwurf"}
            </span>
            <span className="actions">
              {c.status !== "approved" && (
                <button className="small ok" onClick={() => approve(c)}>
                  ✓ Freigeben
                </button>
              )}
              {c.status !== "rejected" && (
                <button className="small" onClick={() => reject(c)}>
                  Ablehnen
                </button>
              )}
              <button className="small danger" onClick={() => remove(c)}>
                ✕
              </button>
            </span>
          </div>
          <div className="mt">
            <textarea
              rows={2}
              value={c.front}
              onChange={(e) => edit(c, "front", e.target.value)}
              style={{ marginBottom: 6 }}
            />
            <textarea
              rows={2}
              value={c.back}
              onChange={(e) => edit(c, "back", e.target.value)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
