import { useEffect, useState } from "react";
import { api, Deck, Course } from "./api";
import Hub from "./views/Hub";
import Wizard from "./views/Wizard";
import Review from "./views/Review";
import Study from "./views/Study";

type View =
  | { name: "hub" }
  | { name: "wizard" }
  | { name: "review"; deckId: string }
  | { name: "study" };

export default function App() {
  const [view, setView] = useState<View>({ name: "hub" });
  const [decks, setDecks] = useState<Deck[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [dueTotal, setDueTotal] = useState(0);

  const refresh = async () => {
    try {
      const [d, c, s] = await Promise.all([
        api.listDecks(),
        api.listCourses(),
        api.stats(),
      ]);
      setDecks(d);
      setCourses(c);
      setDueTotal(s.total_due);
    } catch {
      /* backend not up yet */
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, []);

  const go = (v: View) => {
    setView(v);
    refresh();
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">
          Study<span>deck</span>
        </div>
        <button
          className={`navitem ${view.name === "hub" ? "active" : ""}`}
          onClick={() => go({ name: "hub" })}
        >
          <span>📚</span>
          <span className="label">Card-Decks</span>
        </button>
        <button
          className={`navitem ${view.name === "wizard" ? "active" : ""}`}
          onClick={() => go({ name: "wizard" })}
        >
          <span>✨</span>
          <span className="label">Neue Karten</span>
        </button>
        <button
          className={`navitem ${view.name === "study" ? "active" : ""}`}
          onClick={() => go({ name: "study" })}
        >
          <span>🎯</span>
          <span className="label">Lernen</span>
          {dueTotal > 0 && <span className="badge">{dueTotal}</span>}
        </button>
      </aside>
      <main className="main">
        {view.name === "hub" && (
          <Hub
            decks={decks}
            courses={courses}
            onReview={(deckId) => go({ name: "review", deckId })}
            onStudy={() => go({ name: "study" })}
            onNew={() => go({ name: "wizard" })}
            onRefresh={refresh}
          />
        )}
        {view.name === "wizard" && (
          <Wizard onDone={(deckId) => go({ name: "review", deckId })} onRefresh={refresh} />
        )}
        {view.name === "review" && (
          <Review deckId={view.deckId} onDone={() => go({ name: "hub" })} onRefresh={refresh} />
        )}
        {view.name === "study" && <Study onRefresh={refresh} />}
      </main>
    </div>
  );
}
