import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ActiveJob,
  Analysis,
  Course,
  ExamJob,
  Job,
  Material,
} from "../api";
import CardConfig, { CardConfig as CardCfg } from "./CardConfig";

interface Props {
  courses: Course[];
  initialCardDocId?: string | null;
  onDoneDeck: (deckId: string) => void;
  onDoneExam: (examId: string) => void;
  onRefresh: () => void;
}

type Step = "type" | "cards" | "exam" | "running" | "done" | "error";

const STAGE_LABELS: Record<string, string> = {
  ingest: "Dokument wird gespeichert",
  parse: "PDF wird gelesen",
  analyze: "Inhalte werden analysiert (LLM)",
  generate: "Karten werden erstellt (LLM)",
  figures: "Abbildungen werden ausgeschnitten",
  commit: "Deck wird finalisiert",
  finished: "Fertig",
};

export default function CreateNew({
  courses,
  initialCardDocId,
  onDoneDeck,
  onDoneExam,
  onRefresh,
}: Props) {
  const [step, setStep] = useState<Step>("type");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // shared: selected materials
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  // cards branch
  const [cardDoc, setCardDoc] = useState<Material | null>(null);
  const [cardAnalysis, setCardAnalysis] = useState<Analysis | null>(null);

  // exam branch
  const [kind, setKind] = useState<"exam" | "exercise">("exam");
  const [examCourseId, setExamCourseId] = useState("");
  const [examName, setExamName] = useState("");
  const [count, setCount] = useState(10);
  const [types, setTypes] = useState<string[]>(["mc", "short", "long"]);
  const [diffs, setDiffs] = useState<string[]>(["easy", "medium", "hard"]);
  const [focus, setFocus] = useState("");

  // job
  const [job, setJob] = useState<Job | ExamJob | null>(null);
  const [doneKind, setDoneKind] = useState<"deck" | "exam" | null>(null);
  // True while a create job (cards or exam) is in flight. Kept in a ref too,
  // so effects can check it synchronously without a stale closure.
  const [inFlight, setInFlightState] = useState(false);
  const inFlightRef = useRef(false);
  const setInFlight = (v: boolean) => {
    inFlightRef.current = v;
    setInFlightState(v);
  };
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError("");
      const m = await api.listMaterials();
      setMaterials(m);
      const sel: Record<string, boolean> = {};
      for (const x of m) sel[x.id] = false;
      setSelected(sel);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Stop polling on unmount (tab switch away / view change).
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback(
    (jobId: string, isExam: boolean) => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const cur = isExam
            ? await api.getExamJob(jobId)
            : await api.getJob(jobId);
          setJob(cur);
          if (
            cur.status === "done" ||
            cur.status === "ready" ||
            cur.status === "failed"
          ) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            const failed = cur.status === "failed";
            setInFlight(false);
            if (failed) {
              setError((cur as { error: string }).error || "Job fehlgeschlagen");
              setStep("error");
            } else {
              onRefresh();
              setDoneKind(isExam ? "exam" : "deck");
              setStep("done");
            }
          }
        } catch {
          /* transient */
        }
      }, 3000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onRefresh]
  );

  // Load materials AND restore any in-flight create job. The backend is the
  // source of truth, so the job's progress survives tab switches and full
  // page reloads — we just re-attach to it here on mount.
  useEffect(() => {
    load();
    (async () => {
      try {
        const active: ActiveJob | null = await api.getActiveJob();
        if (active && !inFlightRef.current) {
          const isExam = active.type === "exam";
          setJob(active.job);
          setInFlight(true);
          setStep("running");
          startPolling(active.job.id, isExam);
        }
      } catch {
        /* backend not up yet */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, startPolling]);

  // If we arrived here from "Karten" on a specific material, jump straight
  // into the card flow for that doc — but only if no job is already running
  // (that job takes over the screen instead).
  const initialStarted = useRef(false);
  useEffect(() => {
    if (
      initialCardDocId &&
      materials.length > 0 &&
      !initialStarted.current &&
      !inFlightRef.current
    ) {
      const m = materials.find((x) => x.id === initialCardDocId);
      if (m) {
        initialStarted.current = true;
        pickCardDoc(m);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials, initialCardDocId]);

  const courseName = (id: string | null) =>
    courses.find((c) => c.id === id)?.name ?? "Unzugeordnet";

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  // ---- Cards flow -------------------------------------------------------
  const pickCardDoc = async (m: Material) => {
    setCardDoc(m);
    setStep("cards");
    setBusy(true);
    setError("");
    try {
      const a = await api.analyzeDocument(m.id);
      setCardAnalysis(a.analysis);
    } catch (e) {
      setError(String(e));
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const startCards = async (cfg: CardCfg) => {
    if (!cardDoc || inFlightRef.current) return;
    setBusy(true);
    setError("");
    try {
      const j = await api.startJob({
        doc_id: cardDoc.id,
        config: {
          deck_name: cfg.deckName || undefined,
          card_count: cfg.cardCount || 0,
          topics: cfg.topics,
          card_types: cfg.cardTypes,
          difficulties: cfg.difficulties,
          language: "de",
          images: cfg.images,
          course_id: cardDoc.course_id,
        },
      });
      setJob(j);
      setInFlight(true);
      setStep("running");
      startPolling(j.id, false);
    } catch (e) {
      setError(String(e));
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  // ---- Exam flow --------------------------------------------------------
  const startExam = async () => {
    if (selectedIds.length === 0) {
      setError("Wähle mindestens ein Material aus.");
      return;
    }
    if (types.length === 0) {
      setError("Wähle mindestens einen Aufgabentyp.");
      return;
    }
    if (inFlightRef.current) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.generateExam({
        course_id: examCourseId || null,
        name: examName.trim() || undefined,
        kind,
        doc_ids: selectedIds,
        question_count: count,
        question_types: types,
        difficulties: diffs,
        focus: focus.trim() || undefined,
      });
      setJob(res.job);
      setInFlight(true);
      setStep("running");
      startPolling(res.job.id, true);
    } catch (e) {
      setError(String(e));
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("type");
    setCardDoc(null);
    setCardAnalysis(null);
    setJob(null);
    setDoneKind(null);
    setError("");
    setInFlight(false);
    if (pollRef.current) window.clearInterval(pollRef.current);
  };

  const doneId =
    doneKind === "deck"
      ? (job as Job).deck_id
      : doneKind === "exam"
      ? (job as ExamJob).exam_id
      : undefined;

  return (
    <div className="stagger">
      <h1>Neues erstellen</h1>
      <p className="muted mb">
        Wähle deine Materialien und was du daraus erzeugen möchtest: Karten oder
        eine Prüfung / Übung.
      </p>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      {step === "type" && (
        <>
          {inFlight && (
            <div className="card mb" style={{ borderLeft: "3px solid #6aa7ff" }}>
              <h3 style={{ marginTop: 0 }}>
                ⏳ Ein Job läuft gerade
              </h3>
              <p className="muted" style={{ marginBottom: 0 }}>
                Es ist bereits ein Erstellungs-Job aktiv. Warte, bis er fertig
                ist, bevor du einen neuen startest — nur einer kann gleichzeitig
                laufen.
              </p>
            </div>
          )}
          {materials.length === 0 ? (
            <div className="card">
              <div style={{ fontSize: 30 }}>📄</div>
              <h2>Keine Materialien</h2>
              <p className="muted">
                Lade zuerst ein PDF unter „Materialien" hoch, bevor du etwas
                daraus erzeugen kannst.
              </p>
            </div>
          ) : (
            <div className="grid cols-2">
              <button
                className="card"
                style={{ textAlign: "left", cursor: "pointer" }}
                disabled={inFlight}
                onClick={() => setStep("cards")}
              >
                <div style={{ fontSize: 28 }}>🃏</div>
                <h3 style={{ marginTop: 8 }}>Karten</h3>
                <p className="muted">
                  Aus einem Material ein Karteideck erzeugen (Frage/Antwort,
                  Lückentext, MC).
                </p>
              </button>
              <button
                className="card"
                style={{ textAlign: "left", cursor: "pointer" }}
                disabled={inFlight}
                onClick={() => setStep("exam")}
              >
                <div style={{ fontSize: 28 }}>📝</div>
                <h3 style={{ marginTop: 8 }}>Prüfung / Übung</h3>
                <p className="muted">
                  Aus einem oder mehreren Materialien eine Prüfung oder Übung
                  generieren.
                </p>
              </button>
            </div>
          )}
        </>
      )}

      {step === "cards" && (
        <>
          <div className="card">
            <h3>Material wählen</h3>
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
                    type="radio"
                    name="carddoc"
                    style={{ width: "auto" }}
                    checked={cardDoc?.id === m.id}
                    onChange={() => pickCardDoc(m)}
                  />
                  <span className="name">📄 {m.filename}</span>
                  <span className="muted">
                    {m.page_count} Seiten · {courseName(m.course_id)}
                  </span>
                </label>
              ))
            )}
          </div>

          {cardDoc && cardAnalysis && (
            <CardConfig
              analysis={cardAnalysis}
              docPages={cardDoc.page_count}
              docName={cardDoc.filename}
              defaultName={cardDoc.filename.replace(/\.pdf$/i, "")}
              disabled={inFlight}
              onConfig={startCards}
            />
          )}
          {cardDoc && !cardAnalysis && (
            <div className="card">
              <h2>Analysiere {cardDoc.filename}…</h2>
              <p className="muted">
                Das LLM liest das PDF und gliedert die Themen. Das dauert 30–90
                Sekunden.
              </p>
            </div>
          )}
          <button onClick={reset}>← Zurück</button>
        </>
      )}

      {step === "exam" && (
        <>
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

          <div className="card">
            <h3>Art</h3>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {[
                { v: "exam", label: "Prüfung", desc: "Klausur-artig" },
                { v: "exercise", label: "Übung", desc: "Zum Üben" },
              ].map((k) => (
                <button
                  key={k.v}
                  className={kind === k.v ? "primary" : ""}
                  onClick={() => setKind(k.v as "exam" | "exercise")}
                  style={{ minWidth: 160 }}
                >
                  <div style={{ fontWeight: 600 }}>{k.label}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{k.desc}</div>
                </button>
              ))}
            </div>
            <div className="grid cols-2 mt">
              <div>
                <h3>Kurs</h3>
                <select
                  value={examCourseId}
                  onChange={(e) => setExamCourseId(e.target.value)}
                >
                  <option value="">Automatisch / unzugeordnet</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <h3>Name (optional)</h3>
                <input
                  value={examName}
                  placeholder="z. B. Klausur Abwassertechnik 2026"
                  onChange={(e) => setExamName(e.target.value)}
                />
              </div>
            </div>
          </div>

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
                {[
                  ["mc", "Multiple Choice"],
                  ["short", "Kurzantwort"],
                  ["long", "Ausführlich"],
                ].map(([v, label]) => (
                  <label key={v} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={types.includes(v)}
                      onChange={() => toggle(types, v, setTypes)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <h3 className="mt">Schwierigkeit</h3>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {[
                  ["easy", "einfach"],
                  ["medium", "mittel"],
                  ["hard", "schwer"],
                ].map(([v, label]) => (
                  <label key={v} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={diffs.includes(v)}
                      onChange={() => toggle(diffs, v, setDiffs)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="row">
            <button
              className="primary"
              disabled={busy || inFlight || selectedIds.length === 0}
              onClick={startExam}
            >
              {busy
                ? "Starte…"
                : `Prüfung erstellen (${selectedIds.length} Materialien)`}
            </button>
            <button onClick={reset}>← Zurück</button>
          </div>
        </>
      )}

      {step === "running" && job && (
        <div className="card">
          <h2>
            {"kind" in job
              ? "Erstelle Prüfung…"
              : "Erstelle Karten…"}
          </h2>
          <p className="muted">
            {"stage" in job
              ? STAGE_LABELS[(job as Job).stage] || (job as Job).stage
              : "LLM arbeitet…"}
          </p>
          <div className="progress mt">
            <div style={{ width: `${job.progress}%` }} />
          </div>
          <p className="muted mt">{job.progress} %</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Der Job läuft im Hintergrund und übersteht Neustarts. Du kannst
            zwischen den Tabs wechseln oder die Seite schließen — der Fortschritt
            bleibt erhalten und du siehst ihn hier wieder, sobald du zurückkommst.
          </p>
        </div>
      )}

      {step === "done" && doneId && (
        <div className="card">
          <h2>✅ Fertig</h2>
          <p>
            {doneKind === "deck"
              ? "Dein Deck ist bereit. Prüfe die Karten, bevor du lernst."
              : "Deine Prüfung ist bereit. Du kannst sie jetzt machen und dir korrigieren lassen."}
          </p>
          <div className="row mt">
            <button
              className="primary"
              onClick={() =>
                doneKind === "deck"
                  ? onDoneDeck(doneId)
                  : onDoneExam(doneId)
              }
            >
              {doneKind === "deck" ? "Karten prüfen" : "Prüfung machen"}
            </button>
            <button onClick={reset}>Weiteres erstellen</button>
          </div>
        </div>
      )}

      {step === "error" && (
        <div className="row mt">
          <button className="primary" onClick={reset}>
            Zurück
          </button>
        </div>
      )}
    </div>
  );
}
