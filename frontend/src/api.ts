// API client for the Kartothek backend.

export interface Course {
  id: string;
  name: string;
  slug: string;
  description: string;
  deck_count: number;
  card_count: number;
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
    req<{ id: string }>("/api/courses", {
      method: "POST",
      body: JSON.stringify({ name, description }),
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
};

export function figureUrl(imagePath: string | null): string | null {
  if (!imagePath) return null;
  return `/figures/${imagePath}`;
}
