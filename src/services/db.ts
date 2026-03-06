import { invoke } from "@tauri-apps/api/core";
import type { Highlight, MemoryItem, Thread, ThreadMessage } from "@/types/book";

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
  smartScanStatus?: "none" | "in_progress" | "done";
  bookSummary?: string | null;
  /** Inferred from scan: "essays" | "narrative" | "journal_entries" | "other" — used to simplify structure map for linear books. */
  bookStructureType?: string | null;
}

export type SectionStructureType =
  | "narrative"
  | "journal_entries"
  | "essay"
  | "reference"
  | "prefatory"
  | "other";

export interface SectionSummary {
  id: string;
  bookId: string;
  spineHref: string;
  spineIndex: number;
  tocLabel: string | null;
  charCount: number;
  estimatedTokens: number;
  structureType: SectionStructureType;
  entryCount: number | null;
  summary: string;
  radiusGuide: {
    snippet: number;
    section: number;
    full: number;
  };
  createdAt: number;
}

/** Flat row shape returned from Rust (camelCase from snake_case serde rename). */
interface DbSectionSummaryRow {
  id: string;
  bookId: string;
  spineHref: string;
  spineIndex: number;
  tocLabel: string | null;
  summary: string;
  charCount: number;
  estimatedTokens: number;
  structureType: string;
  entryCount: number | null;
  radiusSnippet: number;
  radiusSection: number;
  radiusFull: number;
  createdAt: number;
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

export async function dbUpdateHighlightAnnotation(
  id: string,
  annotation: string | null
): Promise<void> {
  await invoke("db_update_highlight_annotation", { id, annotation });
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

export async function dbDeleteThread(threadId: string): Promise<void> {
  await invoke("db_delete_thread", { id: threadId });
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

// Phase 30: structured memory items
export interface MemoryItemInput {
  id?: string;
  content: string;
  type: MemoryItem["type"];
  confidence?: number;
  observationCount?: number;
  source?: MemoryItem["source"];
  createdAt?: number;
  lastReinforcedAt?: number;
}

export interface MemoryAnchorInput {
  id?: string;
  memoryId?: string;
  bookId?: string | null;
  highlightId?: string | null;
  threadId?: string | null;
  cfi?: string | null;
  passageText?: string | null;
}

export async function memorySaveItem(
  item: MemoryItemInput,
  anchors: MemoryAnchorInput[]
): Promise<string> {
  return invoke<string>("memory_save_item", {
    item: {
      id: item.id ?? null,
      content: item.content,
      type: item.type,
      confidence: item.confidence ?? 0.5,
      observationCount: item.observationCount ?? 1,
      source: item.source ?? "compaction",
      createdAt: item.createdAt ?? null,
      lastReinforcedAt: item.lastReinforcedAt ?? null,
    },
    anchors: anchors.map((a) => ({
      id: a.id ?? null,
      memoryId: a.memoryId ?? null,
      bookId: a.bookId ?? null,
      highlightId: a.highlightId ?? null,
      threadId: a.threadId ?? null,
      cfi: a.cfi ?? null,
      passageText: a.passageText ?? null,
    })),
  });
}

export async function memoryGetItemsForBook(bookId: string): Promise<MemoryItem[]> {
  return invoke<MemoryItem[]>("memory_get_items_for_book", { bookId });
}

export async function memoryGetItemsGlobal(): Promise<MemoryItem[]> {
  return invoke<MemoryItem[]>("memory_get_items_global");
}

export async function memoryReinforceItem(id: string): Promise<void> {
  await invoke("memory_reinforce_item", { id });
}

export async function memoryDeleteItem(id: string): Promise<void> {
  await invoke("memory_delete_item", { id });
}

const VALID_STRUCTURE_TYPES: SectionStructureType[] = [
  "narrative",
  "journal_entries",
  "essay",
  "reference",
  "prefatory",
  "other",
];

function toSectionSummary(row: DbSectionSummaryRow): SectionSummary {
  return {
    id: row.id,
    bookId: row.bookId,
    spineHref: row.spineHref,
    spineIndex: row.spineIndex,
    tocLabel: row.tocLabel,
    charCount: row.charCount ?? 0,
    estimatedTokens: row.estimatedTokens ?? 0,
    structureType: VALID_STRUCTURE_TYPES.includes(row.structureType as SectionStructureType)
      ? (row.structureType as SectionStructureType)
      : "other",
    entryCount: row.entryCount ?? null,
    summary: row.summary,
    radiusGuide: {
      snippet: row.radiusSnippet ?? 1500,
      section: row.radiusSection ?? 8000,
      full: row.radiusFull ?? 0,
    },
    createdAt: row.createdAt,
  };
}

export async function dbGetSectionSummaries(bookId: string): Promise<SectionSummary[]> {
  const rows = await invoke<DbSectionSummaryRow[]>("db_get_section_summaries", { bookId });
  return rows.map(toSectionSummary);
}

export async function dbUpsertSectionSummary(summary: SectionSummary): Promise<void> {
  await invoke("db_upsert_section_summary", {
    summary: {
      id: summary.id,
      bookId: summary.bookId,
      spineHref: summary.spineHref,
      spineIndex: summary.spineIndex,
      tocLabel: summary.tocLabel ?? null,
      summary: summary.summary,
      charCount: summary.charCount,
      estimatedTokens: summary.estimatedTokens,
      structureType: summary.structureType,
      entryCount: summary.entryCount ?? null,
      radiusSnippet: summary.radiusGuide.snippet,
      radiusSection: summary.radiusGuide.section,
      radiusFull: summary.radiusGuide.full,
      createdAt: summary.createdAt,
    },
  });
}

export async function dbGetBookScanStatus(bookId: string): Promise<string> {
  return invoke<string>("db_get_book_scan_status", { bookId });
}

export async function dbSetBookScanStatus(
  bookId: string,
  status: string
): Promise<void> {
  await invoke("db_set_book_scan_status", { bookId, status });
}

export async function dbGetBookSummary(bookId: string): Promise<string | null> {
  return invoke<string | null>("db_get_book_summary", { bookId });
}

export async function dbSetBookSummary(bookId: string, summary: string): Promise<void> {
  await invoke("db_set_book_summary", { bookId, summary });
}

export async function dbSetBookStructureType(
  bookId: string,
  structureType: string | null
): Promise<void> {
  await invoke("db_set_book_structure_type", {
    bookId,
    structureType: structureType ?? undefined,
  });
}

/** Deletes all section summaries from the DB. */
export async function dbDeleteAllSectionSummaries(): Promise<void> {
  await invoke("db_delete_all_section_summaries");
}

/** Resets scan status, book summary, and structure type for all books. */
export async function dbResetAllBookScanData(): Promise<void> {
  await invoke("db_reset_all_book_scan_data");
}

/** Clears all Smart Scan data so you can start from scratch. */
export async function dbClearAllScanData(): Promise<void> {
  await dbDeleteAllSectionSummaries();
  await dbResetAllBookScanData();
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

