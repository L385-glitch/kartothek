import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Course, Material } from "../api";

interface Props {
  courses: Course[];
  onNewCards: (docId: string) => void; // create cards from this material
  onNewExam: () => void;                // create exam (multi-select)
  onRefresh: () => void;
}

const UNASSIGNED = "__unassigned__";

export default function Materials({
  courses,
  onNewCards,
  onNewExam,
  onRefresh,
}: Props) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Course management state.
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [courseName, setCourseName] = useState("");
  const [courseDesc, setCourseDesc] = useState("");
  const [courseBusy, setCourseBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      setMaterials(await api.listMaterials());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const courseNameOf = (id: string | null) =>
    courses.find((c) => c.id === id)?.name ?? "Unzugeordnet";

  const groups = useMemo(() => {
    const map = new Map<string, Material[]>();
    for (const m of materials) {
      const key = m.course_id ?? UNASSIGNED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    const ordered: { key: string; label: string; items: Material[] }[] = [];
    if (map.has(UNASSIGNED))
      ordered.push({ key: UNASSIGNED, label: "Unzugeordnet", items: map.get(UNASSIGNED)! });
    const courseKeys = [...map.keys()]
      .filter((k) => k !== UNASSIGNED)
      .sort((a, b) => courseNameOf(a).localeCompare(courseNameOf(b)));
    for (const k of courseKeys)
      ordered.push({ key: k, label: courseNameOf(k), items: map.get(k)! });
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials, courses]);

  // ---------- course management ----------

  const openNewCourse = () => {
    setEditingCourse(null);
    setCourseName("");
    setCourseDesc("");
    setShowCourseForm(true);
  };

  const openEditCourse = (c: Course) => {
    setEditingCourse(c);
    setCourseName(c.name);
    setCourseDesc(c.description);
    setShowCourseForm(true);
  };

  const closeCourseForm = () => {
    setShowCourseForm(false);
    setEditingCourse(null);
    setCourseName("");
    setCourseDesc("");
  };

  const saveCourse = async () => {
    const name = courseName.trim();
    if (!name) {
      setError("Bitte einen Kursnamen eingeben.");
      return;
    }
    setCourseBusy(true);
    setError("");
    try {
      if (editingCourse) {
        await api.updateCourse(editingCourse.id, {
          name,
          description: courseDesc,
        });
      } else {
        await api.createCourse(name, courseDesc);
      }
      closeCourseForm();
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCourseBusy(false);
    }
  };

  const removeCourse = async (c: Course) => {
    const noun =
      c.material_count > 0
        ? `${c.material_count} Material${c.material_count === 1 ? "" : "ien"}`
        : "keine Materialien";
    if (
      !confirm(
        `Kurs „${c.name}" wirklich löschen?\n` +
          `Zugeordnete Decks und ${noun} werden nicht gelöscht, sondern als „Unzugeordnet" markiert.`
      )
    )
      return;
    setCourseBusy(true);
    setError("");
    try {
      await api.deleteCourse(c.id);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCourseBusy(false);
    }
  };

  // ---------- materials ----------

  const upload = async (f: File | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      setError("Bitte eine PDF-Datei wählen.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const d = await api.uploadDocument(f);
      if (d.duplicate) {
        setError("Dieses PDF ist bereits vorhanden — es wurde wiederverwendet.");
      }
      await load();
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  };

  const assign = async (m: Material, courseId: string) => {
    setBusyId(m.id);
    try {
      await api.assignMaterial(m.id, courseId === UNASSIGNED ? null : courseId);
      await load();
      onRefresh();
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
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1 style={{ margin: 0 }}>Materialien</h1>
        <button className="primary" onClick={onNewExam}>
          📝 Prüfung / Übung erstellen
        </button>
      </div>
      <p className="muted mb">
        Lade hier deine Vorlesungs-PDFs hoch und ordne sie Kursen zu. Sie bleiben
        gespeichert und können später für Karten oder Prüfungen wiederverwendet
        werden.
      </p>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          upload(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        <div style={{ fontSize: 34 }}>📄</div>
        <div style={{ marginTop: 8 }}>
          {uploading ? "Lade hoch…" : "PDF hierher ziehen oder klicken"}
        </div>
        <div className="muted">Vorlesungsskript als PDF</div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          upload(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />

      {/* ---------- Kursverwaltung ---------- */}
      <div className="card">
        <div className="row spread">
          <h2 style={{ margin: 0 }}>📚 Kurse</h2>
          {!showCourseForm && (
            <button className="small primary" onClick={openNewCourse}>
              + Neuer Kurs
            </button>
          )}
        </div>

        {showCourseForm && (
          <div className="mt" style={{ display: "grid", gap: 8 }}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>
                {editingCourse ? "Kurs bearbeiten" : "Neuer Kurs"}
              </h3>
              <button className="small" onClick={closeCourseForm}>
                ✕ Abbrechen
              </button>
            </div>
            <input
              type="text"
              placeholder="Kursname (z. B. Umweltchemie)"
              value={courseName}
              onChange={(e) => setCourseName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveCourse()}
              autoFocus
            />
            <input
              type="text"
              placeholder="Beschreibung (optional)"
              value={courseDesc}
              onChange={(e) => setCourseDesc(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveCourse()}
            />
            <div>
              <button
                className="primary"
                disabled={courseBusy}
                onClick={() => void saveCourse()}
              >
                {courseBusy
                  ? "Speichere…"
                  : editingCourse
                    ? "Speichern"
                    : "Kurs anlegen"}
              </button>
            </div>
          </div>
        )}

        {courses.length === 0 && !showCourseForm ? (
          <p className="muted mt">
            Noch keine Kurse angelegt. Lege oben deinen ersten Kurs an, um
            Materialien zuzuordnen.
          </p>
        ) : (
          <div className="mt">
            {courses.map((c) => (
              <div
                className="topic-row"
                key={c.id}
                style={{ flexWrap: "wrap", gap: 8 }}
              >
                <span className="name" style={{ minWidth: 200 }}>
                  📚 {c.name}
                  {c.description && (
                    <span className="muted"> · {c.description}</span>
                  )}
                </span>
                <span className="pill">
                  {c.material_count} Material · {c.deck_count} Decks
                </span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button
                    className="small"
                    disabled={courseBusy}
                    onClick={() => openEditCourse(c)}
                  >
                    ✎ Bearbeiten
                  </button>
                  <button
                    className="small danger"
                    disabled={courseBusy}
                    onClick={() => void removeCourse(c)}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- material list ---------- */}
      {loading ? (
        <div className="card">
          <p className="muted">Materialien werden geladen…</p>
        </div>
      ) : materials.length === 0 ? (
        <div className="card">
          <div style={{ fontSize: 30 }}>📄</div>
          <h2>Noch keine Materialien</h2>
          <p className="muted">Lade oben dein erstes Vorlesungs-PDF hoch.</p>
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
                <div
                  className="topic-row"
                  key={m.id}
                  style={{ flexWrap: "wrap", gap: 8 }}
                >
                  <span className="name" style={{ minWidth: 220 }}>
                    📄 {m.filename}
                    <span className="muted">
                      {" "}
                      · {m.page_count} Seiten
                    </span>
                  </span>
                  <select
                    style={{ width: 170 }}
                    value={m.course_id ?? UNASSIGNED}
                    disabled={busyId === m.id}
                    onChange={(ev) => assign(m, ev.target.value)}
                  >
                    <option value={UNASSIGNED}>Unzugeordnet</option>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      className="small primary"
                      disabled={busyId === m.id}
                      onClick={() => onNewCards(m.id)}
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
