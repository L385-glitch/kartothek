import { useEffect, useRef, useState } from "react";
import { api, Analysis, DocumentInfo, Job } from "../api";

interface Props {
  onDone: (deckId: string) => void;
  onRefresh: () => void;
}

type Step = "upload" | "analyze" | "config" | "running" | "done" | "error";

const STAGE_LABELS: Record<string, string> = {
  ingest: "Dokument wird gespeichert",
  parse: "PDF wird gelesen",
  analyze: "Inhalte werden analysiert (LLM)",
  generate: "Karten werden erstellt (LLM)",
  figures: "Abbildungen werden ausgeschnitten",
  commit: "Deck wird finalisiert",
  finished: "Fertig",
};

export default function Wizard({ onDone, onRefresh }: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [doc, setDoc] = useState<DocumentInfo | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // config
  const [deckName, setDeckName] = useState("");
  const [cardCount, setCardCount] = useState(0);
  const [topics, setTopics] = useState<Record<string, number>>({});
  const [cardTypes, setCardTypes] = useState<string[]>(["qa", "cloze", "mc"]);
  const [difficulties, setDifficulties] = useState<string[]>(["easy", "medium", "hard"]);
  const [images, setImages] = useState(true);

  // job
  const [job, setJob] = useState<Job | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      setError("Bitte eine PDF-Datei wählen.");
      return;
    }
    setFile(f);
    setError("");
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const d = await api.uploadDocument(file);
      if (d.duplicate) {
        setError(
          "Dieses PDF ist bereits vorhanden — es wird wiederverwendet (gleiche Inhalte, neue Karten möglich)."
        );
      }
      setDoc(d);
      setStep("analyze");
      const a = await api.analyzeDocument(d.id);
      setAnalysis(a.analysis);
      setDeckName(a.analysis.course_title || file.name.replace(/\.pdf$/i, ""));
      setCardCount(a.analysis.suggested_card_count);
      const t: Record<string, number> = {};
      for (const topic of a.analysis.topics) t[topic.name] = topic.card_suggestion;
      setTopics(t);
      setStep("config");
    } catch (e) {
      setError(String(e));
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (list: string[], v: string, set: (x: string[]) => void) => {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  };

  const startJob = async () => {
    if (!doc) return;
    setBusy(true);
    setError("");
    try {
      // The job endpoint creates the deck itself (it needs source_doc_ids).
      const j = await api.startJob({
        doc_id: doc.id,
        config: {
          deck_name: deckName || undefined,
          card_count: cardCount || 0,
          topics: topics,
          card_types: cardTypes,
          difficulties,
          language: "de",
          images,
        },
      });
      setJob(j);
      setStep("running");
      pollRef.current = window.setInterval(async () => {
        try {
          const cur = await api.getJob(j.id);
          setJob(cur);
          if (cur.status === "done" || cur.status === "failed") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            if (cur.status === "done") {
              onRefresh();
              setStep("done");
            } else {
              setError(cur.error || "Job fehlgeschlagen");
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
    try {
      const j = await api.retryJob(job.id);
      setJob(j);
      setStep("running");
      pollRef.current = window.setInterval(async () => {
        const cur = await api.getJob(j.id);
        setJob(cur);
        if (cur.status === "done" || cur.status === "failed") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          if (cur.status === "done") {
            onRefresh();
            setStep("done");
          } else {
            setError(cur.error || "Job fehlgeschlagen");
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

  const reset = () => {
    setStep("upload");
    setFile(null);
    setDoc(null);
    setAnalysis(null);
    setJob(null);
    setError("");
  };

  const totalTopicCards = Object.values(topics).reduce((a, b) => a + (b || 0), 0);

  return (
    <div className="stagger">
      <h1>Neue Karten erstellen</h1>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      {step === "upload" && (
        <>
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
              pickFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            {file ? (
              <>
                <div style={{ fontSize: 34 }}>📄</div>
                <div style={{ marginTop: 8 }}>{file.name}</div>
                <div className="muted">
                  {(file.size / 1024 / 1024).toFixed(1)} MB — klicken zum Ändern
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 34 }}>📄</div>
                <div style={{ marginTop: 8 }}>
                  Kurs-PDF hierher ziehen oder klicken
                </div>
                <div className="muted">Eine PDF-Datei (Vorlesungsskript)</div>
              </>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            style={{ display: "none" }}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <div className="row mt">
            <button className="primary" disabled={!file || busy} onClick={start}>
              {busy ? "Analysiere…" : "Analysieren & weiter"}
            </button>
          </div>
        </>
      )}

      {step === "analyze" && (
        <div className="card">
          <h2>Analysiere Dokument…</h2>
          <p className="muted">
            Das LLM liest das PDF und gliedert die Themen. Das dauert je nach
            Größe 30–90 Sekunden.
          </p>
        </div>
      )}

      {step === "config" && analysis && (
        <>
          <div className="card">
            <div className="row spread">
              <h2 style={{ margin: 0 }}>
                {analysis.course_title || "Neues Deck"}
              </h2>
              <span className="muted">
                {doc?.page_count} Seiten · {analysis.topics.length} Themen
              </span>
            </div>
            {analysis.summary && <p className="muted mt">{analysis.summary}</p>}
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3>Deck-Name</h3>
              <input value={deckName} onChange={(e) => setDeckName(e.target.value)} />
              <h3 className="mt">Ziel: Anzahl Karten</h3>
              <div className="row">
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={cardCount || ""}
                  placeholder={String(analysis.suggested_card_count)}
                  onChange={(e) => setCardCount(parseInt(e.target.value || "0"))}
                  style={{ width: 120 }}
                />
                <span className="muted">
                  (Vorschlag: {analysis.suggested_card_count} · Themen-Summe: {totalTopicCards})
                </span>
              </div>
            </div>

            <div className="card">
              <h3>Karten-Typen</h3>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {[
                  ["qa", "Frage/Antwort"],
                  ["cloze", "Lückentext"],
                  ["mc", "Multiple Choice"],
                ].map(([v, label]) => (
                  <label key={v} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={cardTypes.includes(v)}
                      onChange={() => toggle(cardTypes, v, setCardTypes)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <h3 className="mt">Schwierigkeitsstufen</h3>
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
                      checked={difficulties.includes(v)}
                      onChange={() => toggle(difficulties, v, setDifficulties)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <h3 className="mt">Abbildungen</h3>
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={images}
                  onChange={() => setImages(!images)}
                />
                Kursabbildungen zu passenden Karten anhängen
              </label>
            </div>
          </div>

          <div className="card">
            <h3>Karten pro Thema</h3>
            {analysis.topics.map((t) => (
              <div className="topic-row" key={t.name}>
                <span className="name">
                  {t.name}{" "}
                  <span className="muted">
                    (Folien {t.slides.slice(0, 3).join(", ")}
                    {t.slides.length > 3 ? "…" : ""})
                  </span>
                </span>
                <span className={`pill ${t.difficulty}`}>{t.difficulty}</span>
                <input
                  type="number"
                  min={0}
                  value={topics[t.name] ?? t.card_suggestion}
                  onChange={(e) =>
                    setTopics({ ...topics, [t.name]: parseInt(e.target.value || "0") })
                  }
                />
              </div>
            ))}
            <p className="muted mt">
              Summe der Themen-Verteilung: <b>{totalTopicCards}</b> Karten. Die
              Gesamtzahl oben übersteuert die Verteilung, wenn sie kleiner ist.
            </p>
          </div>

          <div className="row">
            <button className="primary" disabled={busy} onClick={startJob}>
              {busy ? "Starte…" : `Karten erstellen (~${Math.max(cardCount, totalTopicCards)})`}
            </button>
            <button onClick={reset}>Zurück</button>
          </div>
        </>
      )}

      {step === "running" && job && (
        <div className="card">
          <h2>Erstelle Karten…</h2>
          <p className="muted">
            {STAGE_LABELS[job.stage] || job.stage}
          </p>
          <div className="progress mt">
            <div style={{ width: `${job.progress}%` }} />
          </div>
          <p className="muted mt">{job.progress} %</p>
          <p className="muted">
            Der Job läuft im Hintergrund und übersteht Neustarts. Du kannst die
            Seite schließen — im Lern-Hub siehst du das Ergebnis später.
          </p>
          <div className="row mt">
            <button onClick={() => { onRefresh(); onDone(job.deck_id); }}>
              Zum Lern-Hub
            </button>
          </div>
        </div>
      )}

      {step === "done" && job && (
        <div className="card">
          <h2>✅ Fertig</h2>
          <p>
            Dein Deck „{deckName}“ ist im Lern-Hub. Prüfe die Karten, bevor du
            lernst.
          </p>
          <div className="row mt">
            <button className="primary" onClick={() => onDone(job.deck_id)}>
              Karten prüfen
            </button>
            <button onClick={reset}>Weiteres PDF</button>
          </div>
        </div>
      )}

      {step === "error" && (
        <div className="row mt">
          {job && job.status === "failed" && (
            <button className="primary" onClick={retry}>
              Erneut versuchen
            </button>
          )}
          <button onClick={reset}>Von vorn</button>
        </div>
      )}
    </div>
  );
}
