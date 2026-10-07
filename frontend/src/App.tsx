import { useEffect, useState } from "react";
import { api, Deck, Course } from "./api";
import Hub from "./views/Hub";
import Wizard from "./views/Wizard";
import Review from "./views/Review";
import Study from "./views/Study";
import NewCards from "./views/NewCards";
import Exams from "./views/Exams";
import ExamWizard from "./views/ExamWizard";
import TakeExam from "./views/TakeExam";

type View =
  | { name: "hub" }
  | { name: "newcards" }
  | { name: "wizard"; docId?: string | null }
  | { name: "exams" }
  | { name: "examwizard" }
  | { name: "takeexam"; examId: string }
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

  const navActive = (names: string[]) =>
    names.includes(view.name) ? "active" : "";

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">
          Study<span>deck</span>
        </div>
        <button
          className={`navitem ${navActive(["hub"])}`}
          onClick={() => go({ name: "hub" })}
        >
          <span>📚</span>
          <span className="label">Card-Decks</span>
        </button>
        <button
          className={`navitem ${navActive(["newcards", "wizard"])}`}
          onClick={() => go({ name: "newcards" })}
        >
          <span>✨</span>
          <span className="label">Neue Karten</span>
        </button>
        <button
          className={`navitem ${navActive(["exams", "examwizard", "takeexam"])}`}
          onClick={() => go({ name: "exams" })}
        >
          <span>📝</span>
          <span className="label">Prüfungen</span>
        </button>
        <button
          className={`navitem ${navActive(["study"])}`}
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
            onNew={() => go({ name: "newcards" })}
            onRefresh={refresh}
          />
        )}
        {view.name === "newcards" && (
          <NewCards
            courses={courses}
            onNewCards={() => go({ name: "wizard", docId: null })}
            onReuse={(docId) => go({ name: "wizard", docId })}
            onNewExam={() => go({ name: "examwizard" })}
          />
        )}
        {view.name === "wizard" && (
          <Wizard
            key={view.docId ?? "new"}
            initialDocId={view.docId ?? null}
            onDone={(deckId) => go({ name: "review", deckId })}
            onRefresh={refresh}
          />
        )}
        {view.name === "exams" && (
          <Exams
            courses={courses}
            onTake={(examId) => go({ name: "takeexam", examId })}
            onNewExam={() => go({ name: "examwizard" })}
          />
        )}
        {view.name === "examwizard" && (
          <ExamWizard
            courses={courses}
            onDone={(examId) => go({ name: "takeexam", examId })}
            onRefresh={refresh}
          />
        )}
        {view.name === "takeexam" && (
          <TakeExam
            examId={view.examId}
            onBack={() => go({ name: "exams" })}
          />
        )}
        {view.name === "review" && (
          <Review deckId={view.deckId} onDone={() => go({ name: "hub" })} onRefresh={refresh} />
        )}
        {view.name === "study" && <Study onRefresh={refresh} />}
      </main>
    </div>
  );
}
