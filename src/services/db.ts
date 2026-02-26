import { invoke } from "@tauri-apps/api/core";
import type { Highlight, Thread, ThreadMessage } from "@/types/book";

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

// Highlights
export async function dbGetHighlights(bookId: string): Promise<Highlight[]> {
  return invoke<Highlight[]>("db_get_highlights", { bookId });
}

export async function dbUpsertHighlight(highlight: Highlight): Promise<void> {
  await invoke("db_upsert_highlight", {
    highlight: {
      id: highlight.id,
      bookId: highlight.bookId,
      cfi: highlight.cfi,
      selectedText: highlight.selectedText,
      color: highlight.color ?? "yellow",
      chapterLabel: highlight.chapterLabel ?? null,
      chapterHref: highlight.chapterHref ?? null,
      createdAt: highlight.createdAt,
    },
  });
}

export async function dbDeleteHighlight(id: string): Promise<void> {
  await invoke("db_delete_highlight", { id });
}

export async function dbGetStandaloneHighlights(bookId: string): Promise<Highlight[]> {
  return invoke<Highlight[]>("db_get_standalone_highlights", { bookId });
}

export async function dbGetHighlightsForThread(threadId: string): Promise<Highlight[]> {
  return invoke<Highlight[]>("db_get_highlights_for_thread", { threadId });
}

// Threads (Rust returns archived as 0/1)
interface DbThreadRow extends Omit<Thread, "archived"> {
  archived: number;
}
export async function dbGetThreads(bookId: string): Promise<Thread[]> {
  const rows = await invoke<DbThreadRow[]>("db_get_threads", { bookId });
  return rows.map((t) => ({ ...t, archived: t.archived !== 0 }));
}

export async function dbCreateThread(thread: Thread): Promise<void> {
  await invoke("db_create_thread", {
    thread: {
      id: thread.id,
      bookId: thread.bookId,
      title: thread.title ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archived: thread.archived ? 1 : 0,
    },
  });
}

export async function dbUpdateThreadTitle(threadId: string, title: string): Promise<void> {
  await invoke("db_update_thread_title", { id: threadId, title });
}

export async function dbArchiveThread(threadId: string): Promise<void> {
  await invoke("db_archive_thread", { id: threadId });
}

export async function dbGetThreadMessages(threadId: string): Promise<ThreadMessage[]> {
  return invoke<ThreadMessage[]>("db_get_thread_messages", { threadId });
}

export async function dbSaveThreadMessage(message: ThreadMessage): Promise<void> {
  await invoke("db_save_thread_message", {
    message: {
      id: message.id,
      threadId: message.threadId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      excerptText: message.excerptText ?? null,
      excerptCfi: message.excerptCfi ?? null,
      excerptChapter: message.excerptChapter ?? null,
      excerptColor: message.excerptColor ?? null,
      excerptPage: message.excerptPage ?? null,
    },
  });
}

export async function dbAttachHighlightToThread(
  threadId: string,
  highlightId: string
): Promise<void> {
  await invoke("db_attach_highlight_to_thread", { threadId, highlightId });
}

// Memory (file-based)
export async function memoryEnsureDirs(): Promise<void> {
  await invoke("memory_ensure_dirs");
}

export async function memoryListBooks(): Promise<string[]> {
  return invoke<string[]>("memory_list_books");
}

export async function memoryReadBook(bookId: string): Promise<string | null> {
  return invoke<string | null>("memory_read_book", { bookId });
}

export async function memoryWriteBook(bookId: string, content: string): Promise<void> {
  await invoke("memory_write_book", { bookId, content });
}

export async function memoryReadReader(): Promise<string | null> {
  return invoke<string | null>("memory_read_reader");
}

export async function memoryWriteReader(content: string): Promise<void> {
  await invoke("memory_write_reader", { content });
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

