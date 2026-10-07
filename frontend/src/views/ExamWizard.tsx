import { useCallback, useEffect, useRef, useState } from "react";
import { api, Course, Exam, ExamJob, Material } from "../api";

interface Props {
  courses: Course[];
  onDone: (examId: string) => void; // jump to take/view exam
  onRefresh: () => void;
}

type Step = "config" | "running" | "done" | "error";

const KINDS: { v: "exam" | "exercise"; label: string; desc: string }[] = [
  { v: "exam", label: "Prüfung", desc: "Klausur-artig, gemischte Schwierigkeit" },
  { v: "exercise", label: "Übung", desc: "Lockerer, zum Üben" },
];

const TYPE_OPTIONS: { v: string; label: string }[] = [
  { v: "mc", label: "Multiple Choice" },
  { v: "short", label: "Kurzantwort" },
  { v: "long", label: "Ausführlich" },
];

const DIFF_OPTIONS: { v: string; label: string }[] = [
  { v: "easy", label: "einfach" },
  { v: "medium", label: "mittel" },
  { v: "hard", label: "schwer" },
];

export default function ExamWizard({ courses, onDone, onRefresh }: Props) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // config
  const [kind, setKind] = useState<"exam" | "exercise">("exam");
  const [courseId, setCourseId] = useState<string>("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [count, setCount] = useState(10);
  const [types, setTypes] = useState<string[]>(["mc", "short", "long"]);
  const [diffs, setDiffs] = useState<string[]>(["easy", "medium", "hard"]);
  const [focus, setFocus] = useState("");

  const [exam, setExam] = useState<Exam | null>(null);
  const [job, setJob] = useState<ExamJob | null>(null);
  const [step, setStep] = useState<Step>("config");
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError("");
      const m = await api.listMaterials();
      setMaterials(m);
      // default: select all materials of the chosen course (or all unassigned)
      setSelected({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [load]);

  // When a course is picked, preselect its materials.
  useEffect(() => {
    const sel: Record<string, boolean> = {};
    for (const m of materials) {
      if (courseId) sel[m.id] = m.course_id === courseId;
      else sel[m.id] = m.course_id == null;
    }
    setSelected(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, materials]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  const start = async () => {
    if (selectedIds.length === 0) {
      setError("Wähle mindestens ein Material aus.");
      return;
    }
    if (types.length === 0) {
      setError("Wähle mindestens einen Aufgabentyp.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api.generateExam({
        course_id: courseId || null,
        name: name.trim() || undefined,
        kind,
        doc_ids: selectedIds,
        question_count: count,
        question_types: types,
        difficulties: diffs,
        focus: focus.trim() || undefined,
      });
      setExam(res.exam);
      setJob(res.job);
      setStep("running");
      pollRef.current = window.setInterval(async () => {
        try {
          const cur = await api.getExamJob(res.job.id);
          setJob(cur);
          if (cur.status === "ready" || cur.status === "failed") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            if (cur.status === "ready") {
              onRefresh();
              setStep("done");
            } else {
              setError(cur.error || "Prüfung konnte nicht erstellt werden");
              setStep("error");
            }
          }
        } catch {
          /* transient */
        }
      }, 3000);
    } catch (e) {
      setError(String(e));
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const j = await api.retryExamJob(job.id);
      setJob(j);
      setStep("running");
      pollRef.current = window.setInterval(async () => {
        const cur = await api.getExamJob(j.id);
        setJob(cur);
        if (cur.status === "ready" || cur.status === "failed") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          if (cur.status === "ready") {
            onRefresh();
            setStep("done");
          } else {
            setError(cur.error || "Prüfung konnte nicht erstellt werden");
            setStep("error");
          }
        }
      }, 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const courseName = (id: string | null) =>
    courses.find((c) => c.id === id)?.name ?? "Unzugeordnet";

  return (
    <div className="stagger">
      <h1>Prüfung / Übung erstellen</h1>
      <p className="muted mb">
        Erzeuge aus deinen importierten Materialien eine Prüfung oder Übung. Die
        Aufgaben werden vom LLM aus dem Vorlesungstext generiert.
      </p>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      {step === "config" && (
        <>
          <div className="card">
            <h3>Art</h3>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {KINDS.map((k) => (
                <button
                  key={k.v}
                  className={kind === k.v ? "primary" : ""}
                  onClick={() => setKind(k.v)}
                  style={{ minWidth: 180 }}
                >
                  <div style={{ fontWeight: 600 }}>{k.label}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{k.desc}</div>
                </button>
              ))}
            </div>
            <div className="grid cols-2 mt">
              <div>
                <h3>Kurs</h3>
                <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                  <option value="">Alle / unzugeordnet</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <h3>Name (optional)</h3>
                <input
                  value={name}
                  placeholder="z. B. Klausur Abwassertechnik 2026"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>
          </div>

          {materials.length === 0 ? (
            <div className="card">
              <h3>Materialien</h3>
              <p className="muted">
                Keine Materialien vorhanden. Importiere zuerst ein PDF unter
                „Neue Karten“.
              </p>
            </div>
          ) : (
            <div className="card">
              <h3>Materialien ({selectedIds.length} ausgewählt)</h3>
              {loading ? (
                <p className="muted">Lade…</p>
              ) : (
                materials.map((m) => (
                  <label
                    key={m.id}
                    className="topic-row"
                    style={{ cursor: "pointer", flexWrap: "wrap" }}
                  >
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={!!selected[m.id]}
                      onChange={() =>
                        setSelected({ ...selected, [m.id]: !selected[m.id] })
                      }
                    />
                    <span className="name">📄 {m.filename}</span>
                    <span className="muted">
                      {m.page_count} Seiten · {courseName(m.course_id)}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}

          <div className="grid cols-2">
            <div className="card">
              <h3>Anzahl Aufgaben</h3>
              <div className="row">
                <input
                  type="number"
                  min={3}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(parseInt(e.target.value || "0"))}
                  style={{ width: 100 }}
                />
                <span className="muted">Aufgaben</span>
              </div>
              <h3 className="mt">Fokus (optional)</h3>
              <input
                value={focus}
                placeholder="z. B. Schwerpunkt Stickstoffelimination"
                onChange={(e) => setFocus(e.target.value)}
              />
            </div>
            <div className="card">
              <h3>Aufgabentypen</h3>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {TYPE_OPTIONS.map((t) => (
                  <label key={t.v} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={types.includes(t.v)}
                      onChange={() => toggle(types, t.v, setTypes)}
                    />
                    {t.label}
                  </label>
                ))}
              </div>
              <h3 className="mt">Schwierigkeit</h3>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {DIFF_OPTIONS.map((d) => (
                  <label key={d.v} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={diffs.includes(d.v)}
                      onChange={() => toggle(diffs, d.v, setDiffs)}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="row">
            <button
              className="primary"
              disabled={busy || selectedIds.length === 0}
              onClick={start}
            >
              {busy ? "Starte…" : `Prüfung erstellen (${selectedIds.length} Materialien)`}
            </button>
          </div>
        </>
      )}

      {step === "running" && job && (
        <div className="card">
          <h2>Erstelle {kind === "exam" ? "Prüfung" : "Übung"}…</h2>
          <p className="muted">
            Das LLM liest die Materialien und erstellt die Aufgaben. Das dauert
            je nach Umfang 1–5 Minuten.
          </p>
          <div className="progress mt">
            <div style={{ width: `${job.progress}%` }} />
          </div>
          <p className="muted mt">{job.progress} %</p>
          <p className="muted">
            Der Job läuft im Hintergrund und übersteht Neustarts. Du kannst die
            Seite schließen — im Prüfungen-Bereich siehst du das Ergebnis.
          </p>
          <div className="row mt">
            <button onClick={() => onDone(job.exam_id!)}>Zu den Prüfungen</button>
          </div>
        </div>
      )}

      {step === "done" && exam && (
        <div className="card">
          <h2>✅ Fertig</h2>
          <p>
            Deine {kind === "exam" ? "Prüfung" : "Übung"} „{exam.name}“ ist
            bereit. Du kannst sie jetzt machen und dir die Antworten korrigieren
            lassen.
          </p>
          <div className="row mt">
            <button className="primary" onClick={() => onDone(exam.id)}>
              Prüfung machen
            </button>
          </div>
        </div>
      )}

      {step === "error" && (
        <div className="row mt">
          {job && job.status === "failed" && (
            <button className="primary" onClick={retry}>Erneut versuchen</button>
          )}
          <button onClick={() => setStep("config")}>Zurück</button>
        </div>
      )}
    </div>
  );
}
