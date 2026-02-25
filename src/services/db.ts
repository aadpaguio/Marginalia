import { invoke } from "@tauri-apps/api/core";
import type { BookNote } from "@/types/book";

export interface StoredBook {
  id: string;
  title: string;
  author?: string | null;
  filePath: string;
  coverPath?: string | null;
  lastReadCfi?: string | null;
  progressFraction: number;
  addedAt: number;
  lastOpenedAt?: number | null;
}

export async function dbGetAllBooks(): Promise<StoredBook[]> {
  return invoke<StoredBook[]>("db_get_all_books");
}

export async function dbUpsertBook(book: StoredBook): Promise<void> {
  await invoke("db_upsert_book", { book: JSON.stringify(book) });
}

export async function dbUpdateReadingProgress(
  bookId: string,
  cfi: string,
  fraction: number
): Promise<void> {
  await invoke("db_update_reading_progress", { bookId, cfi, fraction });
}

export async function dbGetBook(id: string): Promise<StoredBook | null> {
  return invoke<StoredBook | null>("db_get_book", { id });
}

export async function dbDeleteBook(id: string): Promise<void> {
  await invoke("db_delete_book", { id });
}

interface StoredNoteRow {
  id: string;
  bookId: string;
  cfi: string;
  selectedText?: string | null;
  text?: string | null;
  style?: string | null;
  color?: string | null;
  note: string;
  noteKind: "highlight" | "ai_note";
  aiConversation?: string | null;
  chapterLabel?: string | null;
  chapterHref?: string | null;
  pageLabel?: string | null;
  pageHref?: string | null;
  pageCurrent?: number | null;
  pageTotal?: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

function mapRowToNote(row: StoredNoteRow): BookNote {
  let aiConversation: BookNote["aiConversation"] = [];
  if (row.aiConversation) {
    try {
      const parsed = JSON.parse(row.aiConversation) as BookNote["aiConversation"];
      aiConversation = Array.isArray(parsed) ? parsed : [];
    } catch {
      aiConversation = [];
    }
  }
  return {
    id: row.id,
    type: "annotation",
    bookId: row.bookId,
    cfi: row.cfi,
    selectedText: row.selectedText ?? undefined,
    text: row.text ?? undefined,
    style: (row.style as BookNote["style"]) ?? "highlight",
    color: row.color ?? "yellow",
    note: row.note ?? "",
    aiConversation,
    chapterLabel: row.chapterLabel ?? undefined,
    chapterHref: row.chapterHref ?? undefined,
    pageLabel: row.pageLabel ?? undefined,
    pageHref: row.pageHref ?? undefined,
    pageCurrent: row.pageCurrent ?? undefined,
    pageTotal: row.pageTotal ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

function mapNoteToRow(note: BookNote, bookId: string): StoredNoteRow {
  const aiConversation = note.aiConversation && note.aiConversation.length > 0
    ? JSON.stringify(note.aiConversation)
    : null;
  return {
    id: note.id,
    bookId,
    cfi: note.cfi,
    selectedText: note.selectedText ?? null,
    text: note.text ?? null,
    style: note.style ?? "highlight",
    color: note.color ?? "yellow",
    note: note.note ?? "",
    noteKind: aiConversation ? "ai_note" : "highlight",
    aiConversation,
    chapterLabel: note.chapterLabel ?? null,
    chapterHref: note.chapterHref ?? null,
    pageLabel: note.pageLabel ?? null,
    pageHref: note.pageHref ?? null,
    pageCurrent: note.pageCurrent ?? null,
    pageTotal: note.pageTotal ?? null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt ?? null,
  };
}

export async function dbGetNotes(bookId: string): Promise<BookNote[]> {
  const rows = await invoke<StoredNoteRow[]>("db_get_notes", { bookId });
  return rows.map(mapRowToNote);
}

export async function dbUpsertNote(bookId: string, note: BookNote): Promise<void> {
  const row = mapNoteToRow(note, bookId);
  await invoke("db_upsert_note", { note: row });
}

export async function dbDeleteNote(id: string): Promise<void> {
  await invoke("db_delete_note", { id });
}

export interface StoredBookmark {
  id: string;
  bookId: string;
  cfi: string;
  chapterLabel?: string | null;
  createdAt: number;
}

export async function dbGetBookmarks(bookId: string): Promise<StoredBookmark[]> {
  return invoke<StoredBookmark[]>("db_get_bookmarks", { bookId });
}

export async function dbUpsertBookmark(bookmark: StoredBookmark): Promise<void> {
  await invoke("db_upsert_bookmark", { bookmark });
}

export async function dbDeleteBookmark(id: string): Promise<void> {
  await invoke("db_delete_bookmark", { id });
}

