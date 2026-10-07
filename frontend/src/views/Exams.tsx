import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Course, Exam } from "../api";

interface Props {
  courses: Course[];
  onTake: (examId: string) => void;
  onNewExam: () => void;
}

const UNASSIGNED = "__unassigned__";

export default function Exams({ courses, onTake, onNewExam }: Props) {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

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

  const groups = useMemo(() => {
    const map = new Map<string, Exam[]>();
    for (const e of exams) {
      const key = e.course_id ?? UNASSIGNED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    const ordered: { key: string; label: string; items: Exam[] }[] = [];
    if (map.has(UNASSIGNED))
      ordered.push({ key: UNASSIGNED, label: "Unzugeordnet", items: map.get(UNASSIGNED)! });
    const courseKeys = [...map.keys()]
      .filter((k) => k !== UNASSIGNED)
      .sort((a, b) => courseName(a).localeCompare(courseName(b)));
    for (const k of courseKeys)
      ordered.push({ key: k, label: courseName(k), items: map.get(k)! });
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exams, courses]);

  const startRename = (e: Exam) => {
    setRenaming(e.id);
    setRenameVal(e.name);
  };

  const saveRename = async (id: string) => {
    if (!renameVal.trim()) return;
    setBusyId(id);
    try {
      await api.renameExam(id, renameVal.trim());
      setRenaming(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId("");
    }
  };

  const move = async (e: Exam, courseId: string) => {
    setBusyId(e.id);
    try {
      await api.moveExam(e.id, courseId === UNASSIGNED ? null : courseId);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId("");
    }
  };

  const remove = async (e: Exam) => {
    if (!confirm(`„${e.name}" wirklich löschen?`)) return;
    setBusyId(e.id);
    try {
      await api.deleteExam(e.id);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="stagger">
      <h1>Prüfungen & Übungen</h1>
      <p className="muted mb">
        Deine aus den Materialien generierten Prüfungen und Übungen. Mache sie
        und lass dir die Antworten vom LLM korrigieren.
      </p>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      <div className="row mb">
        <button className="primary" onClick={onNewExam}>
          📝 Neue Prüfung / Übung
        </button>
      </div>

      {loading ? (
        <div className="card">
          <p className="muted">Prüfungen werden geladen…</p>
        </div>
      ) : exams.length === 0 ? (
        <div className="card">
          <div style={{ fontSize: 30 }}>📝</div>
          <h2>Keine Prüfungen</h2>
          <p className="muted">
            Erstelle deine erste Prüfung oder Übung aus deinen importierten
            Materialien.
          </p>
          <button className="primary mt" onClick={onNewExam}>
            📝 Prüfung erstellen
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
              <span className="pill">{g.items.length}</span>
            </div>
            <div className="mt">
              {g.items.map((e) => (
                <div
                  className="topic-row"
                  key={e.id}
                  style={{ flexWrap: "wrap", gap: 8 }}
                >
                  {renaming === e.id ? (
                    <input
                      className="name"
                      style={{ minWidth: 220 }}
                      value={renameVal}
                      autoFocus
                      onChange={(ev) => setRenameVal(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") saveRename(e.id);
                        if (ev.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="name" style={{ minWidth: 220 }}>
                      {e.kind === "exam" ? "📝" : "🏋️"} {e.name}
                      <span className="muted">
                        {" "}
                        · {e.question_count} Aufgaben · {e.total_points} Pkt
                      </span>
                    </span>
                  )}
                  <span className={`pill ${e.status}`}>{e.status}</span>
                  <select
                    style={{ width: 170 }}
                    value={e.course_id ?? UNASSIGNED}
                    disabled={busyId === e.id}
                    onChange={(ev) => move(e, ev.target.value)}
                  >
                    <option value={UNASSIGNED}>Unzugeordnet</option>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <span
                    style={{ marginLeft: "auto", display: "flex", gap: 6 }}
                  >
                    {e.status === "ready" && (
                      <button
                        className="small primary"
                        onClick={() => onTake(e.id)}
                      >
                        Machen
                      </button>
                    )}
                    <button
                      className="small"
                      onClick={() => startRename(e)}
                    >
                      Umbenennen
                    </button>
                    <button
                      className="small danger"
                      disabled={busyId === e.id}
                      onClick={() => remove(e)}
                    >
                      Löschen
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
