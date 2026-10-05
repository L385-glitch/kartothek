import { useRef, useState } from "react";
import { api, Course, Deck } from "../api";

interface Props {
  decks: Deck[];
  courses: Course[];
  onReview: (deckId: string) => void;
  onStudy: () => void;
  onNew: () => void;
  onRefresh: () => void;
}

export default function Hub({ decks, courses, onReview, onStudy, onNew, onRefresh }: Props) {
  const [newCourse, setNewCourse] = useState("");
  const [error, setError] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const [importDeck, setImportDeck] = useState<string | null>(null);

  const addCourse = async () => {
    if (!newCourse.trim()) return;
    try {
      await api.createCourse(newCourse.trim());
      setNewCourse("");
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const moveDeck = async (deck: Deck, courseId: string | null) => {
    try {
      await api.moveDeck(deck.id, courseId);
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeDeck = async (deck: Deck) => {
    if (!confirm(`Deck "${deck.name}" wirklich löschen?`)) return;
    try {
      await api.deleteDeck(deck.id);
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const exportDeck = (deck: Deck, format: "csv" | "json" | "apkg") => {
    window.open(api.exportUrl(deck.id, format), "_blank");
  };

  const doImport = async (file: File) => {
    if (!importDeck) return;
    try {
      const r = await api.importDeck(importDeck, file);
      alert(`${r.imported} Karten importiert.`);
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
    setImportDeck(null);
  };

  const unfiled = decks.filter((d) => !d.course_id);
  const pending = decks.filter((d) => d.status === "draft");

  const deckCard = (d: Deck) => (
    <div className="card" key={d.id}>
      <div className="row spread">
        <div>
          <h3 style={{ margin: 0 }}>{d.name}</h3>
          <span className="muted">
            {d.approved_count}/{d.card_count} Karten ·{" "}
            <span className={`pill ${d.status}`}>{d.status === "ready" ? "bereit" : "Entwurf"}</span>
          </span>
        </div>
        <select
          value={d.course_id ?? ""}
          onChange={(e) => moveDeck(d, e.target.value || null)}
          style={{ width: 180 }}
          title="In Kurs verschieben"
        >
          <option value="">— kein Kurs —</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row mt">
        <button className="small primary" onClick={() => onReview(d.id)}>
          Karten prüfen
        </button>
        {d.status === "ready" && (
          <button className="small" onClick={onStudy}>
            Lernen
          </button>
        )}
        <span style={{ marginLeft: "auto" }} />
        <button className="small" onClick={() => exportDeck(d, "apkg")}>
          Anki
        </button>
        <button className="small" onClick={() => exportDeck(d, "csv")}>
          CSV
        </button>
        <button className="small" onClick={() => exportDeck(d, "json")}>
          JSON
        </button>
        <button
          className="small"
          onClick={() => {
            setImportDeck(d.id);
            importRef.current?.click();
          }}
        >
          Import
        </button>
        <button className="small danger" onClick={() => removeDeck(d)}>
          ✕
        </button>
      </div>
    </div>
  );

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1>Lern-Hub</h1>
        <button className="primary" onClick={onNew}>
          + Neue Karten erstellen
        </button>
      </div>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      {pending.length > 0 && (
        <section className="mb">
          <h2>Neue Decks (noch nicht geprüft)</h2>
          {pending.map(deckCard)}
        </section>
      )}

      <section className="mb">
        <div className="row spread mb">
          <h2 style={{ margin: 0 }}>Kurse</h2>
          <div className="row">
            <input
              placeholder="Neuer Kurs…"
              value={newCourse}
              onChange={(e) => setNewCourse(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCourse()}
              style={{ width: 200 }}
            />
            <button className="small" onClick={addCourse}>
              anlegen
            </button>
          </div>
        </div>
        {courses.length === 0 && (
          <p className="muted">Noch keine Kurse. Lege oben einen Kurs an und verschiebe Decks hinein.</p>
        )}
        {courses.map((c) => {
          const cd = decks.filter((d) => d.course_id === c.id);
          return (
            <div className="card" key={c.id}>
              <div className="row spread">
                <h3 style={{ margin: 0 }}>
                  📁 {c.name}{" "}
                  <span className="muted">
                    {cd.length} Decks · {c.card_count} Karten
                  </span>
                </h3>
                <button
                  className="small danger"
                  onClick={async () => {
                    if (!confirm(`Kurs "${c.name}" löschen? (Decks bleiben erhalten)`)) return;
                    await api.deleteCourse(c.id);
                    onRefresh();
                  }}
                >
                  ✕
                </button>
              </div>
              {cd.length === 0 ? (
                <p className="muted mt">Leer — Decks per Auswahl oben hierher verschieben.</p>
              ) : (
                cd.map(deckCard)
              )}
            </div>
          );
        })}
      </section>

      {unfiled.filter((d) => d.status === "ready").length > 0 && (
        <section>
          <h2>Ohne Kurs</h2>
          {unfiled
            .filter((d) => d.status === "ready")
            .map(deckCard)}
        </section>
      )}

      <input
        ref={importRef}
        type="file"
        accept=".csv,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) doImport(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
