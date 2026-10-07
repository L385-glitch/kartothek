import { useEffect, useState } from "react";
import { api, Deck, Course } from "./api";
import Materials from "./views/Materials";
import Learning from "./views/Learning";
import CreateNew from "./views/CreateNew";
import Review from "./views/Review";
import Study from "./views/Study";
import TakeExam from "./views/TakeExam";

type Tab = "materials" | "learning" | "create";

type View =
  | { name: "tab"; tab: Tab }
  | { name: "review"; deckId: string }
  | { name: "study" }
  | { name: "takeexam"; examId: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "tab", tab: "materials" });
  const [decks, setDecks] = useState<Deck[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [dueTotal, setDueTotal] = useState(0);
  // When set, the Create tab opens the card flow pre-focused on this material.
  const [createCardsDocId, setCreateCardsDocId] = useState<string | null>(null);

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

  const goTab = (tab: Tab) => {
    setCreateCardsDocId(null);
    setView({ name: "tab", tab });
    refresh();
  };

  const goCreateCards = (docId: string) => {
    setCreateCardsDocId(docId);
    setView({ name: "tab", tab: "create" });
  };

  const activeTab =
    view.name === "tab"
      ? view.tab
      : view.name === "takeexam"
      ? "learning"
      : "learning";

  const navActive = (tab: Tab) => (activeTab === tab ? "active" : "");

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">
          Study<span>deck</span>
        </div>
        <button
          className={`navitem ${navActive("materials")}`}
          onClick={() => goTab("materials")}
        >
          <span>📄</span>
          <span className="label">Materialien</span>
        </button>
        <button
          className={`navitem ${navActive("learning")}`}
          onClick={() => goTab("learning")}
        >
          <span>🎯</span>
          <span className="label">Lernen</span>
        </button>
        <button
          className={`navitem ${navActive("create")}`}
          onClick={() => goTab("create")}
        >
          <span>✨</span>
          <span className="label">Neues erstellen</span>
        </button>
        <button
          className={`navitem ${view.name === "study" ? "active" : ""}`}
          onClick={() => setView({ name: "study" })}
        >
          <span>📖</span>
          <span className="label">Lernsession</span>
          {dueTotal > 0 && <span className="badge">{dueTotal}</span>}
        </button>
      </aside>
      <main className="main">
        {view.name === "tab" && view.tab === "materials" && (
          <Materials
            courses={courses}
            onNewCards={goCreateCards}
            onNewExam={() => goTab("create")}
            onRefresh={refresh}
          />
        )}
        {view.name === "tab" && view.tab === "learning" && (
          <Learning
            courses={courses}
            decks={decks}
            onReview={(deckId) => setView({ name: "review", deckId })}
            onStudy={() => setView({ name: "study" })}
            onTakeExam={(examId) => setView({ name: "takeexam", examId })}
            onNew={() => goTab("create")}
            onRefresh={refresh}
          />
        )}
        {view.name === "tab" && view.tab === "create" && (
          <CreateNew
            key={createCardsDocId ?? "blank"}
            courses={courses}
            initialCardDocId={createCardsDocId}
            onDoneDeck={(deckId) => setView({ name: "review", deckId })}
            onDoneExam={(examId) => setView({ name: "takeexam", examId })}
            onRefresh={refresh}
          />
        )}
        {view.name === "review" && (
          <Review
            deckId={view.deckId}
            onDone={() => goTab("learning")}
            onRefresh={refresh}
          />
        )}
        {view.name === "study" && <Study onRefresh={refresh} />}
        {view.name === "takeexam" && (
          <TakeExam examId={view.examId} onBack={() => goTab("learning")} />
        )}
      </main>
    </div>
  );
}
