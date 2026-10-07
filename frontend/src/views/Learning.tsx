import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Course, Deck, Exam } from "../api";

interface Props {
  courses: Course[];
  decks: Deck[];
  onReview: (deckId: string) => void;
  onStudy: () => void;
  onTakeExam: (examId: string) => void;
  onNew: () => void; // jump to Create new
  onRefresh: () => void;
}

const UNASSIGNED = "__unassigned__";

export default function Learning({
  courses,
  decks,
  onReview,
  onStudy,
  onTakeExam,
  onNew,
  onRefresh,
}: Props) {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setExams(await api.listExams());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const courseName = (id: string | null) =>
    courses.find((c) => c.id === id)?.name ?? "Unzugeordnet";

  // Group decks + exams by course.
  const groups = useMemo(() => {
    const map = new Map<string, { decks: Deck[]; exams: Exam[] }>();
    const ensure = (key: string) => {
      if (!map.has(key)) map.set(key, { decks: [], exams: [] });
      return map.get(key)!;
    };
    for (const d of decks) ensure(d.course_id ?? UNASSIGNED).decks.push(d);
    for (const e of exams) ensure(e.course_id ?? UNASSIGNED).exams.push(e);
    const ordered: { key: string; label: string; decks: Deck[]; exams: Exam[] }[] = [];
    if (map.has(UNASSIGNED)) {
      const v = map.get(UNASSIGNED)!;
      ordered.push({ key: UNASSIGNED, label: "Unzugeordnet", ...v });
    }
    const courseKeys = [...map.keys()]
      .filter((k) => k !== UNASSIGNED)
      .sort((a, b) => courseName(a).localeCompare(courseName(b)));
    for (const k of courseKeys) {
      const v = map.get(k)!;
      ordered.push({ key: k, label: courseName(k), ...v });
    }
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decks, exams, courses]);

  const exportDeck = (deck: Deck, format: "csv" | "json" | "apkg") => {
    window.open(api.exportUrl(deck.id, format), "_blank");
  };

  const removeDeck = async (deck: Deck) => {
    if (!confirm(`Deck „${deck.name}" wirklich löschen?`)) return;
    setBusyId(deck.id);
    try {
      await api.deleteDeck(deck.id);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId("");
    }
  };

  const removeExam = async (e: Exam) => {
    if (!confirm(`„${e.name}" wirklich löschen?`)) return;
    setBusyId(e.id);
    try {
      await api.deleteExam(e.id);
      await load();
      onRefresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId("");
    }
  };

  const hasContent = decks.length > 0 || exams.length > 0;

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1 style={{ margin: 0 }}>Lernen</h1>
        <button className="primary" onClick={onNew}>
          + Neues erstellen
        </button>
      </div>
      <p className="muted mb">
        Deine generierten Karteidecks und Prüfungen, nach Kursen geordnet. Lerne,
        wiederhole oder mache Prüfungen.
      </p>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="card">
          <p className="muted">Wird geladen…</p>
        </div>
      ) : !hasContent ? (
        <div className="card">
          <div style={{ fontSize: 30 }}>🎯</div>
          <h2>Noch nichts zu lernen</h2>
          <p className="muted">
            Erstelle zuerst Karten oder eine Prüfung aus deinen Materialien.
          </p>
          <button className="primary mt" onClick={onNew}>
            + Neues erstellen
          </button>
        </div>
      ) : (
        groups.map((g) => (
          <div className="card" key={g.key}>
            <div className="row spread">
              <h2 style={{ margin: 0 }}>
                {g.key === UNASSIGNED ? "🗂️ " : "📚 "}
                {g.label}
              </h2>
              <span className="pill">
                {g.decks.length} Decks · {g.exams.length} Prüfungen
              </span>
            </div>

            {g.decks.length > 0 && (
              <div className="mt">
                <h3>Karteidecks</h3>
                {g.decks.map((d) => (
                  <div
                    className="topic-row"
                    key={d.id}
                    style={{ flexWrap: "wrap", gap: 8 }}
                  >
                    <span className="name" style={{ minWidth: 220 }}>
                      🃏 {d.name}
                      <span className="muted">
                        {" "}
                        · {d.approved_count}/{d.card_count} Karten
                      </span>
                    </span>
                    <span className={`pill ${d.status}`}>
                      {d.status === "ready" ? "bereit" : "Entwurf"}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button
                        className="small primary"
                        onClick={() => onReview(d.id)}
                      >
                        Prüfen
                      </button>
                      {d.status === "ready" && (
                        <button className="small" onClick={onStudy}>
                          Lernen
                        </button>
                      )}
                      <button className="small" onClick={() => exportDeck(d, "apkg")}>
                        Anki
                      </button>
                      <button className="small" onClick={() => exportDeck(d, "csv")}>
                        CSV
                      </button>
                      <button
                        className="small danger"
                        disabled={busyId === d.id}
                        onClick={() => removeDeck(d)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {g.exams.length > 0 && (
              <div className="mt">
                <h3>Prüfungen & Übungen</h3>
                {g.exams.map((e) => (
                  <div
                    className="topic-row"
                    key={e.id}
                    style={{ flexWrap: "wrap", gap: 8 }}
                  >
                    <span className="name" style={{ minWidth: 220 }}>
                      {e.kind === "exam" ? "📝" : "🏋️"} {e.name}
                      <span className="muted">
                        {" "}
                        · {e.question_count} Aufgaben · {e.total_points} Pkt
                      </span>
                    </span>
                    <span className={`pill ${e.status}`}>{e.status}</span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      {e.status === "ready" && (
                        <button
                          className="small primary"
                          onClick={() => onTakeExam(e.id)}
                        >
                          Machen
                        </button>
                      )}
                      <button
                        className="small danger"
                        disabled={busyId === e.id}
                        onClick={() => removeExam(e)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
