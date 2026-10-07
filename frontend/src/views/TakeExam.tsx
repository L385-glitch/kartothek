import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ExamAttempt,
  ExamDetail,
  ExamJob,
  ExamQuestion,
} from "../api";

interface Props {
  examId: string;
  onBack: () => void;
}

type Phase = "loading" | "answer" | "grading" | "result" | "error";

const LETTERS = "ABCDEFGH";

export default function TakeExam({ examId, onBack }: Props) {
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<ExamAttempt | null>(null);
  const [job, setJob] = useState<ExamJob | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const loadExam = useCallback(async () => {
    try {
      const e = await api.getExam(examId);
      setExam(e);
      if (e.status !== "ready") {
        setError(
          e.status === "failed"
            ? `Prüfung fehlgeschlagen: ${e.error}`
            : "Prüfung ist noch nicht fertig."
        );
        setPhase("error");
        return;
      }
      // Pre-fill with any latest attempt's answers so re-grading is easy.
      const attempts = await api.listAttempts(examId);
      if (attempts.length > 0) {
        const last = attempts[0]; // newest first (backend orders desc)
        setAnswers(last.answers);
        if (last.status === "graded") {
          setAttempt(last);
          setPhase("result");
          return;
        }
      }
      setPhase("answer");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, [examId]);

  useEffect(() => {
    loadExam();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [loadExam]);

  const startGradingPoll = (jobId: string) => {
    pollRef.current = window.setInterval(async () => {
      try {
        const cur = await api.getExamJob(jobId);
        setJob(cur);
        if (cur.status === "ready" || cur.status === "failed") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          if (cur.status === "ready") {
            const a = await api.getAttempt(examId, cur.attempt_id!);
            setAttempt(a);
            setPhase("result");
          } else {
            setError(cur.error || "Korrektur fehlgeschlagen");
            setPhase("error");
          }
        }
      } catch {
        /* transient */
      }
    }, 3000);
  };

  const setAnswer = (qid: string, val: string) =>
    setAnswers((a) => ({ ...a, [qid]: val }));

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.submitAttempt(examId, answers);
      setJob(res.job);
      setPhase("grading");
      startGradingPoll(res.job.id);
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  const resubmit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.resubmitAttempt(
        examId,
        attempt!.id,
        answers, // current (possibly edited) answers
        note.trim()
      );
      setJob(res.job);
      setPhase("grading");
      startGradingPoll(res.job.id);
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading")
    return (
      <div className="card">
        <p className="muted">Prüfung wird geladen…</p>
      </div>
    );

  if (phase === "error")
    return (
      <div className="stagger">
        <h1>Prüfung</h1>
        <div className="error mb">{error}</div>
        <button onClick={onBack}>Zurück</button>
      </div>
    );

  const answeredCount = Object.values(answers).filter((v) => v.trim() !== "")
    .length;
  const total = exam?.content.length ?? 0;

  return (
    <div className="stagger">
      <div className="row spread mb">
        <h1 style={{ margin: 0 }}>
          {exam?.kind === "exam" ? "Prüfung" : "Übung"}: {exam?.name}
        </h1>
        <button className="small" onClick={onBack}>← Zurück</button>
      </div>

      {error && (
        <div className="error mb" onClick={() => setError("")}>
          {error}
        </div>
      )}

      {phase === "answer" && exam && (
        <>
          <div className="card">
            <div className="row spread">
              <span className="muted">
                {answeredCount}/{total} beantwortet · {exam.total_points} Punkte
                insgesamt
              </span>
              <span className="muted">
                {exam.kind === "exam" ? "Klausur" : "Übung"}
              </span>
            </div>
          </div>

          {exam.content.map((q, i) => (
            <QuestionCard
              key={q.id}
              index={i}
              q={q}
              answer={answers[q.id] ?? ""}
              onChange={(v) => setAnswer(q.id, v)}
            />
          ))}

          <div className="row">
            <button
              className="primary"
              disabled={busy || answeredCount === 0}
              onClick={submit}
            >
              {busy ? "Reiche ein…" : "Einreichen & korrigieren lassen"}
            </button>
            {answeredCount < total && (
              <span className="muted">
                Hinweis: {total - answeredCount} Aufgabe(n) noch offen.
              </span>
            )}
          </div>
        </>
      )}

      {phase === "grading" && (
        <div className="card">
          <h2>Korrigiere deine Antworten…</h2>
          <p className="muted">
            Das LLM liest deine Antworten und den Vorlesungstext und bewertet
            jede Aufgabe einzeln. Das dauert 30–90 Sekunden.
          </p>
          <div className="progress mt">
            <div style={{ width: `${job?.progress ?? 0}%` }} />
          </div>
          <p className="muted mt">{job?.progress ?? 0} %</p>
        </div>
      )}

      {phase === "result" && exam && attempt && (
        <>
          <div className="card result-summary">
            <div className="row spread">
              <div>
                <h2 style={{ margin: 0 }}>Ergebnis</h2>
                <span className="muted">
                  {attempt.resubmit_note
                    ? `Nachreichung: ${attempt.resubmit_note}`
                    : "Erste Abgabe"}
                </span>
              </div>
              <div className="score">
                {attempt.score}
                <span className="muted"> / {attempt.max_score} Pkt</span>
              </div>
            </div>
            <p className="muted mt">
              {Math.round((attempt.score / Math.max(attempt.max_score, 1)) * 100)}
              % der Punkte. Du kannst deine Antworten unten anpassen und
              erneut korrigieren lassen.
            </p>
          </div>

          {exam.content.map((q, i) => {
            const g = attempt.grading[q.id];
            return (
              <QuestionCard
                key={q.id}
                index={i}
                q={q}
                answer={attempt.answers[q.id] ?? ""}
                onChange={(v) => setAnswer(q.id, v)}
                grading={g}
                editable
              />
            );
          })}

          <div className="card">
            <h3>Erneut korrigieren lassen</h3>
            <p className="muted">
              Passe oben deine Antworten an und gib optional eine kurze Erklärung
              ab (z. B. warum du etwas anders meinst). Das LLM bewertet dann
              neu.
            </p>
            <textarea
              value={note}
              placeholder="Optionale Erklärung / Anmerkung (z. B. Ich habe die Antwort in Aufgabe 3 korrigiert…)"
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
            <div className="row mt">
              <button className="primary" disabled={busy} onClick={resubmit}>
                {busy ? "Korrigiere…" : "Erneut korrigieren"}
              </button>
              <button onClick={() => { setNote(""); loadExam(); }}>
                Antworten zurücksetzen
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function QuestionCard({
  index,
  q,
  answer,
  onChange,
  grading,
  editable,
}: {
  index: number;
  q: ExamQuestion;
  answer: string;
  onChange: (v: string) => void;
  grading?: {
    correct: boolean;
    points: number;
    max_points: number;
    feedback: string;
  } | null;
  editable?: boolean;
}) {
  return (
    <div className="card question">
      <div className="row spread">
        <span className="muted">
          Aufgabe {index + 1} · {q.points} Pkt
          {q.source_pages.length > 0 && (
            <span> · Folie {q.source_pages.join(", ")}</span>
          )}
        </span>
        {grading && (
          <span className={`pill ${grading.correct ? "ready" : "hard"}`}>
            {grading.points}/{grading.max_points}
          </span>
        )}
      </div>

      <p className="question-text mt">{q.text}</p>

      {q.type === "mc" && q.options.length > 0 ? (
        <div className="mc-options">
          {q.options.map((opt, i) => {
            const letter = LETTERS[i];
            const isChosen = answer.trim().toUpperCase() === letter;
            let cls = "mc-option";
            if (!grading) {
              if (isChosen) cls += " selected";
            } else {
              const correctLetter =
                LETTERS[q.correct_index] ?? "";
              if (letter === correctLetter) cls += " correct";
              else if (isChosen) cls += " wrong";
              else cls += " static";
            }
            return (
              <button
                key={i}
                className={cls}
                disabled={!!grading}
                onClick={() => onChange(letter)}
              >
                <span className="mc-letter">{letter}</span>
                <span>{opt.replace(/^[A-Z]\)\s*/, "")}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <textarea
          value={answer}
          disabled={!editable && !!grading}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder="Deine Antwort…"
        />
      )}

      {grading && (
        <div className={`grading ${grading.correct ? "good" : "bad"}`}>
          <div className="row spread">
            <b>{grading.correct ? "✓ Richtig" : "✗ Nicht vollständig"}</b>
            <span>
              {grading.points}/{grading.max_points} Pkt
            </span>
          </div>
          {grading.feedback && <p className="muted mt">{grading.feedback}</p>}
        </div>
      )}

      {grading && q.answer_key && q.type !== "mc" && (
        <div className="muted mt" style={{ fontSize: 13 }}>
          <b>Musterlösung:</b> {q.answer_key}
        </div>
      )}
    </div>
  );
}
