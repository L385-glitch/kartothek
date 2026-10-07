// API client for the Studydeck backend.

export interface Course {
  id: string;
  name: string;
  slug: string;
  description: string;
  deck_count: number;
  card_count: number;
  material_count: number;
}

export interface Deck {
  id: string;
  course_id: string | null;
  name: string;
  description: string;
  language: string;
  status: "draft" | "ready";
  card_count: number;
  approved_count: number;
  created_at: string;
}

export interface Card {
  id: string;
  deck_id: string;
  front: string;
  back: string;
  type: "qa" | "cloze" | "mc";
  topic: string;
  difficulty: "easy" | "medium" | "hard";
  status: "draft" | "approved" | "rejected";
  source_pages: number[];
  needs_image: boolean;
  image_hint: string;
  image_path: string | null;
  created_at: string;
}

export interface Topic {
  name: string;
  slides: number[];
  card_suggestion: number;
  difficulty: string;
}

export interface Analysis {
  course_title: string;
  topics: Topic[];
  suggested_card_count: number;
  summary: string;
}

export interface Job {
  id: string;
  deck_id: string;
  doc_id: string | null;
  status: "pending" | "running" | "done" | "failed";
  stage: string;
  progress: number;
  config: Record<string, unknown>;
  analysis: Analysis;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentInfo {
  id: string;
  filename: string;
  page_count: number;
  layout: string;
  duplicate: boolean;
}

// ---------- materials (Neue Karten library) ----------

export interface Material {
  id: string;
  filename: string;
  sha256: string;
  page_count: number;
  layout: string;
  status: string;
  course_id: string | null;
  analysis: Analysis;
  created_at: string;
}

// ---------- exams / exercises ----------

export interface ExamQuestion {
  id: string;
  type: "mc" | "short" | "long";
  text: string;
  points: number;
  options: string[];
  correct_index: number;
  answer_key: string;
  explanation: string;
  source_pages: number[];
}

export interface Exam {
  id: string;
  course_id: string | null;
  name: string;
  kind: "exam" | "exercise";
  status: "draft" | "ready" | "failed";
  source_doc_ids: string[];
  total_points: number;
  question_count: number;
  config: Record<string, unknown>;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface ExamDetail extends Exam {
  content: ExamQuestion[];
}

export interface GradingEntry {
  id: string;
  correct: boolean;
  points: number;
  max_points: number;
  feedback: string;
}

export interface ExamAttempt {
  id: string;
  exam_id: string;
  answers: Record<string, string>;
  grading: Record<string, GradingEntry>;
  score: number;
  max_score: number;
  status: "pending" | "graded" | "failed";
  resubmit_note: string;
  error: string;
  created_at: string;
  graded_at: string | null;
}

export interface ExamJob {
  id: string;
  exam_id: string | null;
  attempt_id: string | null;
  kind: "generate" | "grade";
  status: "draft" | "ready" | "failed";
  progress: number;
  source_doc_ids: string[];
  config: Record<string, unknown>;
  error: string;
  created_at: string;
  updated_at: string;
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.detail) msg = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // health
  health: () => req<{ ok: boolean }>("/api/health"),

  // courses
  listCourses: () => req<Course[]>("/api/courses"),
  createCourse: (name: string, description = "") =>
    req<Course>("/api/courses", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  updateCourse: (id: string, patch: { name?: string; description?: string }) =>
    req<Course>(`/api/courses/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteCourse: (id: string) =>
    req<void>(`/api/courses/${id}`, { method: "DELETE" }),

  // decks
  listDecks: (courseId?: string) =>
    req<Deck[]>(`/api/decks${courseId ? `?course_id=${courseId}` : ""}`),
  getDeck: (id: string) =>
    req<Deck & { cards: Card[] }>(`/api/decks/${id}`),
  moveDeck: (id: string, courseId: string | null) =>
    req<Deck>(`/api/decks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ course_id: courseId }),
    }),
  deleteDeck: (id: string) =>
    req<void>(`/api/decks/${id}`, { method: "DELETE" }),

  // documents + jobs
  uploadDocument: async (file: File): Promise<DocumentInfo> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/documents", { method: "POST", body: form });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return res.json();
  },
  analyzeDocument: (docId: string) =>
    req<{ analysis: Analysis; cached: boolean }>(
      `/api/documents/${docId}/analyze`,
      { method: "POST", body: JSON.stringify({ doc_id: docId }) }
    ),
  getDocument: (docId: string) => req<DocumentInfo>(`/api/documents/${docId}`),
  startJob: (body: {
    doc_id: string;
    config: Record<string, unknown>;
  }) => req<Job>("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
  getJob: (id: string) => req<Job>(`/api/jobs/${id}`),
  listJobs: () => req<Job[]>("/api/jobs"),
  retryJob: (id: string) =>
    req<Job>(`/api/jobs/${id}/retry`, { method: "POST" }),

  // cards
  listCards: (deckId: string, status?: string) =>
    req<Card[]>(
      `/api/decks/${deckId}/cards${status ? `?status=${status}` : ""}`
    ),
  updateCard: (
    id: string,
    patch: Partial<{
      front: string;
      back: string;
      topic: string;
      difficulty: string;
      card_type: string;
      status: string;
      image_path: string;
    }>
  ) =>
    req<Card>(`/api/cards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  approveCard: (id: string) =>
    req<Card>(`/api/cards/${id}/approve`, { method: "POST" }),
  rejectCard: (id: string) =>
    req<Card>(`/api/cards/${id}/reject`, { method: "POST" }),
  approveAll: (deckId: string) =>
    req<{ approved: number }>(`/api/decks/${deckId}/approve-all`, {
      method: "POST",
    }),
  deleteCard: (id: string) =>
    req<void>(`/api/cards/${id}`, { method: "DELETE" }),

  // study
  dueCards: (deckId?: string, courseId?: string, limit = 50) => {
    const p = new URLSearchParams();
    if (deckId) p.set("deck_id", deckId);
    if (courseId) p.set("course_id", courseId);
    p.set("limit", String(limit));
    return req<Card[]>(`/api/study/due?${p.toString()}`);
  },
  reviewCard: (cardId: string, rating: number) =>
    req<unknown>(`/api/study/review/${cardId}`, {
      method: "POST",
      body: JSON.stringify({ rating }),
    }),
  stats: () =>
    req<{
      decks: {
        deck_id: string;
        course_id: string | null;
        name: string;
        cards: number;
        due: number;
        new: number;
      }[];
      total_due: number;
      total_new: number;
      total_cards: number;
    }>("/api/stats"),

  // import/export
  exportUrl: (deckId: string, format: "csv" | "json" | "apkg") =>
    `/api/decks/${deckId}/export?format=${format}`,
  importDeck: async (deckId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/decks/${deckId}/import`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`import failed: ${res.status}`);
    return res.json();
  },

  // ---------- materials (Neue Karten library) ----------
  listMaterials: (courseId?: string) =>
    req<Material[]>(`/api/materials${courseId ? `?course_id=${courseId}` : ""}`),
  assignMaterial: (docId: string, courseId: string | null) =>
    req<Material>(`/api/materials/${docId}/assign`, {
      method: "POST",
      body: JSON.stringify({ course_id: courseId }),
    }),
  deleteMaterial: (docId: string) =>
    req<void>(`/api/materials/${docId}`, { method: "DELETE" }),

  // ---------- exams / exercises ----------
  generateExam: (body: {
    course_id?: string | null;
    name?: string;
    kind: "exam" | "exercise";
    doc_ids: string[];
    question_count: number;
    question_types: string[];
    difficulties: string[];
    focus?: string;
  }) =>
    req<{ exam: Exam; job: ExamJob }>("/api/exams/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listExams: (courseId?: string, kind?: string) => {
    const p = new URLSearchParams();
    if (courseId) p.set("course_id", courseId);
    if (kind) p.set("kind", kind);
    const q = p.toString();
    return req<Exam[]>(`/api/exams${q ? `?${q}` : ""}`);
  },
  getExam: (id: string) => req<ExamDetail>(`/api/exams/${id}`),
  renameExam: (id: string, name: string) =>
    req<Exam>(`/api/exams/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  moveExam: (id: string, courseId: string | null) =>
    req<Exam>(`/api/exams/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ course_id: courseId }),
    }),
  deleteExam: (id: string) =>
    req<void>(`/api/exams/${id}`, { method: "DELETE" }),
  getExamJob: (id: string) => req<ExamJob>(`/api/exam-jobs/${id}`),
  retryExamJob: (id: string) =>
    req<ExamJob>(`/api/exam-jobs/${id}/retry`, { method: "POST" }),
  submitAttempt: (examId: string, answers: Record<string, string>) =>
    req<{ attempt: ExamAttempt; job: ExamJob }>(
      `/api/exams/${examId}/attempts`,
      { method: "POST", body: JSON.stringify({ answers }) }
    ),
  listAttempts: (examId: string) =>
    req<ExamAttempt[]>(`/api/exams/${examId}/attempts`),
  getAttempt: (examId: string, attemptId: string) =>
    req<ExamAttempt>(`/api/exams/${examId}/attempts/${attemptId}`),
  resubmitAttempt: (
    examId: string,
    attemptId: string,
    answers: Record<string, string> | null,
    note: string
  ) =>
    req<{ attempt: ExamAttempt; job: ExamJob }>(
      `/api/exams/${examId}/attempts/${attemptId}/resubmit`,
      { method: "POST", body: JSON.stringify({ answers, note }) }
    ),
  deleteAttempt: (examId: string, attemptId: string) =>
    req<void>(`/api/exams/${examId}/attempts/${attemptId}`, {
      method: "DELETE",
    }),
};

export function figureUrl(imagePath: string | null): string | null {
  if (!imagePath) return null;
  return `/figures/${imagePath}`;
}
