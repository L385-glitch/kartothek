import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Course, Material } from "../api";

interface Props {
  courses: Course[];
  onNewCards: () => void;          // upload a fresh PDF (wizard, no doc)
  onReuse: (docId: string) => void; // create cards from an existing material
  onNewExam: () => void;           // jump to exam creation
}

const UNASSIGNED = "__unassigned__";

export default function NewCards({
  courses,
  onNewCards,
  onReuse,
  onNewExam,
}: Props) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const m = await api.listMaterials();
      setMaterials(m);
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

  // Group materials by course; unassigned bucket first, then courses by name.
  const groups = useMemo(() => {
    const map = new Map<string, Material[]>();
    for (const m of materials) {
      const key = m.course_id ?? UNASSIGNED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    const ordered: { key: string; label: string; items: Material[] }[] = [];
    // Unassigned first
    if (map.has(UNASSIGNED)) {
      ordered.push({ key: UNASSIGNED, label: "Unzugeordnet", items: map.get(UNASSIGNED)! });
    }
    // Then courses present in materials, sorted by name
    const courseKeys = [...map.keys()].filter((k) => k !== UNASSIGNED).sort((a, b) =>
      courseName(a).localeCompare(courseName(b))
    );
    for (const k of courseKeys) {
      ordered.push({ key: k, label: courseName(k), items: map.get(k)! });
    }
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials, courses]);

  const assign = async (m: Material, courseId: string) => {
    const target = courseId === UNASSIGNED ? null : courseId;
    setBusyId(m.id);
    try {
      await api.assignMaterial(m.id, target);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId("");
    }
  };

  const remove = async (m: Material) => {
    if (!confirm(`„${m.filename}" wirklich löschen?`)) return;
    setBusyId(m.id);
    try {
      await api.deleteMaterial(m.id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="stagger">
      <h1>Neue Karten</h1>
      <p className="muted mb">
        Hier liegen deine importierten Kurs-PDFs, sortiert nach Kurs. Wiederverwende
        sie, um daraus Karten oder Prüfungen zu erzeugen.
      </p>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      <div className="row mb" style={{ flexWrap: "wrap" }}>
        <button className="primary" onClick={onNewCards}>
          📄 Neues PDF importieren
        </button>
        <button onClick={onNewExam}>📝 Prüfung / Übung erstellen</button>
      </div>

      {loading ? (
        <div className="card">
          <p className="muted">Materialien werden geladen…</p>
        </div>
      ) : materials.length === 0 ? (
        <div className="card">
          <div style={{ fontSize: 30 }}>🗂️</div>
          <h2>Keine Materialien</h2>
          <p className="muted">
            Importiere dein erstes Vorlesungs-PDF — es erscheint hier, sortiert nach
            Kurs, und kann immer wieder für neue Karten oder Prüfungen genutzt werden.
          </p>
          <button className="primary mt" onClick={onNewCards}>
            📄 PDF importieren
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
              {g.items.map((m) => (
                <div className="topic-row" key={m.id} style={{ flexWrap: "wrap" }}>
                  <span className="name" style={{ minWidth: 180 }}>
                    📄 {m.filename}
                    <span className="muted">
                      {" "}
                      · {m.page_count} Seiten · {m.layout}
                    </span>
                  </span>
                  <span className={`pill ${m.status}`}>{m.status}</span>
                  <select
                    style={{ width: 190 }}
                    value={m.course_id ?? UNASSIGNED}
                    disabled={busyId === m.id}
                    onChange={(e) => assign(m, e.target.value)}
                  >
                    <option value={UNASSIGNED}>Unzugeordnet</option>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <span className="actions" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      className="small"
                      disabled={busyId === m.id}
                      onClick={() => onReuse(m.id)}
                    >
                      ✨ Karten
                    </button>
                    <button
                      className="small danger"
                      disabled={busyId === m.id}
                      onClick={() => remove(m)}
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
