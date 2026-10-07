import { useState } from "react";
import { Analysis } from "../api";

interface Props {
  analysis: Analysis;
  docPages?: number;
  docName?: string;
  defaultName?: string;
  onConfig: (cfg: CardConfig) => void;
}

export interface CardConfig {
  deckName: string;
  cardCount: number;
  topics: Record<string, number>;
  cardTypes: string[];
  difficulties: string[];
  images: boolean;
}

export default function CardConfig({
  analysis,
  docPages,
  docName,
  defaultName,
  onConfig,
}: Props) {
  const [deckName, setDeckName] = useState(defaultName ?? "");
  const [cardCount, setCardCount] = useState(analysis.suggested_card_count);
  const [topics, setTopics] = useState<Record<string, number>>(() => {
    const t: Record<string, number> = {};
    for (const topic of analysis.topics) t[topic.name] = topic.card_suggestion;
    return t;
  });
  const [cardTypes, setCardTypes] = useState<string[]>(["qa", "cloze", "mc"]);
  const [difficulties, setDifficulties] = useState<string[]>([
    "easy",
    "medium",
    "hard",
  ]);
  const [images, setImages] = useState(true);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const totalTopicCards = Object.values(topics).reduce((a, b) => a + (b || 0), 0);

  return (
    <>
      <div className="card">
        <div className="row spread">
          <h2 style={{ margin: 0 }}>{analysis.course_title || docName || "Neues Deck"}</h2>
          <span className="muted">
            {docPages ? `${docPages} Seiten · ` : ""}
            {analysis.topics.length} Themen
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
        <button
          className="primary"
          onClick={() =>
            onConfig({
              deckName: deckName.trim(),
              cardCount,
              topics,
              cardTypes,
              difficulties,
              images,
            })
          }
        >
          Karten erstellen (~{Math.max(cardCount, totalTopicCards)})
        </button>
      </div>
    </>
  );
}
