/**
 * Prints the assembled system prompt to MDs/SAMPLE_SYSTEM_PROMPT.md.
 * Uses the real SQLite DB when available (same file the app uses), else mocked data.
 *
 * Real DB: set MARGINALIA_DB_PATH to the DB file, or leave unset to use default:
 *   macOS: ~/Library/Application Support/app.marginalia.reader/marginalia/marginalia.db
 *   Linux: ~/.local/share/app.marginalia.reader/marginalia/marginalia.db
 *   Windows: %APPDATA%\app.marginalia.reader\marginalia\marginalia.db
 * Optionally set MARGINALIA_BOOK_ID to a specific book id; otherwise the first book is used.
 *
 * Run: npm run print-prompt
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { invoke } from "@tauri-apps/api/core";
import { assembleThreadContext, type ThreadContextParams } from "@/services/claude";
import {
  dbGetSectionSummaries,
  dbGetBook,
  type StoredBook,
  type SectionSummary,
} from "@/services/db";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const APP_ID = "app.marginalia.reader";

function getDefaultDbPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_ID, "marginalia", "marginalia.db");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? home;
    return path.join(appData, APP_ID, "marginalia", "marginalia.db");
  }
  return path.join(home, ".local", "share", APP_ID, "marginalia", "marginalia.db");
}

/** Load book and section summaries from the real SQLite DB. Returns null if DB missing or no books. */
async function loadFromRealDb(): Promise<{
  book: StoredBook;
  sectionSummaries: SectionSummary[];
} | null> {
  const dbPath = process.env.MARGINALIA_DB_PATH ?? getDefaultDbPath();
  if (!fs.existsSync(dbPath)) return null;

  let Database: typeof import("better-sqlite3").default;
  try {
    const mod = await import("better-sqlite3");
    Database = mod.default;
  } catch {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const envBookId = process.env.MARGINALIA_BOOK_ID;
    const firstRow = db.prepare("SELECT id FROM books LIMIT 1").get() as { id: string } | undefined;
    const id = (typeof envBookId === "string" && envBookId) ? envBookId : firstRow?.id ?? null;
    if (!id) return null;

    const bookRow = db.prepare(
      `SELECT id, title, author, file_path, cover_path, last_read_cfi, progress_fraction, added_at, last_opened_at,
              COALESCE(smart_scan_status, 'none') as smart_scan_status, book_summary, book_structure_type
       FROM books WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    if (!bookRow) return null;

    const book: StoredBook = {
      id: String(bookRow.id),
      title: String(bookRow.title ?? "Book"),
      author: bookRow.author != null ? String(bookRow.author) : null,
      filePath: String(bookRow.file_path),
      coverPath: bookRow.cover_path != null ? String(bookRow.cover_path) : null,
      lastReadCfi: bookRow.last_read_cfi != null ? String(bookRow.last_read_cfi) : null,
      progressFraction: Number(bookRow.progress_fraction ?? 0),
      addedAt: Number(bookRow.added_at ?? 0),
      lastOpenedAt: bookRow.last_opened_at != null ? Number(bookRow.last_opened_at) : null,
      smartScanStatus: String(bookRow.smart_scan_status ?? "none"),
      bookSummary: bookRow.book_summary != null ? String(bookRow.book_summary) : null,
      bookStructureType: bookRow.book_structure_type != null ? String(bookRow.book_structure_type) : null,
    };

    const sectionRows = db.prepare(
      `SELECT id, book_id, spine_href, spine_index, toc_label, summary,
              COALESCE(char_count, 0) as char_count, COALESCE(estimated_tokens, 0) as estimated_tokens,
              COALESCE(structure_type, 'other') as structure_type, entry_count,
              COALESCE(radius_snippet, 1500) as radius_snippet, COALESCE(radius_section, 8000) as radius_section, COALESCE(radius_full, 0) as radius_full,
              created_at
       FROM section_summaries WHERE book_id = ? ORDER BY spine_index ASC`
    ).all(id) as Record<string, unknown>[];

    const sectionSummaries: SectionSummary[] = sectionRows.map((row) => ({
      id: String(row.id),
      bookId: String(row.book_id),
      spineHref: String(row.spine_href),
      spineIndex: Number(row.spine_index),
      tocLabel: row.toc_label != null ? String(row.toc_label) : null,
      charCount: Number(row.char_count),
      estimatedTokens: Number(row.estimated_tokens),
      structureType: ["narrative", "journal_entries", "essay", "reference", "prefatory", "other"].includes(String(row.structure_type))
        ? (row.structure_type as SectionSummary["structureType"])
        : "other",
      entryCount: row.entry_count != null ? Number(row.entry_count) : null,
      summary: String(row.summary),
      radiusGuide: {
        snippet: Number(row.radius_snippet),
        section: Number(row.radius_section),
        full: Number(row.radius_full),
      },
      createdAt: Number(row.created_at),
    }));

    return { book, sectionSummaries };
  } finally {
    db.close();
  }
}

/** DB row shape returned from Rust (camelCase). Same as db.ts internal type. */
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

const TEST_BOOK_ID = "print-prompt-book-id";

function fixtureDbSectionSummaryRows(): DbSectionSummaryRow[] {
  return [
    { id: `${TEST_BOOK_ID}-spine-0`, bookId: TEST_BOOK_ID, spineHref: "OPS/praise.html", spineIndex: 0, tocLabel: "Praise", summary: "Blurb and praise quotes.", charCount: 2700, estimatedTokens: 675, structureType: "prefatory", entryCount: null, radiusSnippet: 170, radiusSection: 683, radiusFull: 854, createdAt: 0 },
    { id: `${TEST_BOOK_ID}-spine-1`, bookId: TEST_BOOK_ID, spineHref: "OPS/epigraph.html", spineIndex: 1, tocLabel: "Epigraph", summary: "Epigraphs.", charCount: 130, estimatedTokens: 32, structureType: "prefatory", entryCount: null, radiusSnippet: 32, radiusSection: 131, radiusFull: 164, createdAt: 0 },
    { id: `${TEST_BOOK_ID}-spine-2`, bookId: TEST_BOOK_ID, spineHref: "OPS/contents.html", spineIndex: 2, tocLabel: "Contents", summary: "Table of contents.", charCount: 470, estimatedTokens: 117, structureType: "reference", entryCount: null, radiusSnippet: 117, radiusSection: 471, radiusFull: 589, createdAt: 0 },
    { id: `${TEST_BOOK_ID}-spine-3`, bookId: TEST_BOOK_ID, spineHref: "OPS/chapter_01.html", spineIndex: 3, tocLabel: "On Essays and Essayists", summary: "Opening meditation on the essay form.", charCount: 5300, estimatedTokens: 1325, structureType: "essay", entryCount: null, radiusSnippet: 529, radiusSection: 2117, radiusFull: 2646, createdAt: 0 },
    { id: `${TEST_BOOK_ID}-spine-4`, bookId: TEST_BOOK_ID, spineHref: "OPS/chapter_02.html", spineIndex: 4, tocLabel: "On Essayism", summary: "Essayism as form and attitude.", charCount: 6500, estimatedTokens: 1625, structureType: "essay", entryCount: null, radiusSnippet: 650, radiusSection: 2600, radiusFull: 3250, createdAt: 0 },
  ];
}

function fixtureStoredBook(): StoredBook {
  return {
    id: TEST_BOOK_ID,
    title: "Essayism",
    author: "Brian Dillon",
    filePath: "/path/to/essayism.epub",
    progressFraction: 0,
    addedAt: 0,
    smartScanStatus: "done",
    bookSummary: "A meditation on the essay as form and attitude. Dillon moves between canonical essayists and personal reflection, arguing that essayism holds exactitude and evasion in tension.",
    bookStructureType: "essays",
  };
}

describe("print-system-prompt", () => {
  beforeEach(() => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "db_get_section_summaries" && (args as { bookId?: string })?.bookId === TEST_BOOK_ID) {
        return Promise.resolve(fixtureDbSectionSummaryRows());
      }
      if (cmd === "db_get_book" && (args as { id?: string })?.id === TEST_BOOK_ID) {
        return Promise.resolve(fixtureStoredBook());
      }
      return Promise.resolve(null);
    }) as typeof invoke);
  });

  it("writes assembled system prompt (real DB if available, else mock)", async () => {
    let book: StoredBook | null = null;
    let sectionSummaries: SectionSummary[] = [];

    const fromDb = await loadFromRealDb();
    if (fromDb) {
      book = fromDb.book;
      sectionSummaries = [...fromDb.sectionSummaries].sort((a, b) => a.spineIndex - b.spineIndex);
    } else {
      const [bookFromMock, summariesFromMock] = await Promise.all([
        dbGetBook(TEST_BOOK_ID),
        dbGetSectionSummaries(TEST_BOOK_ID),
      ]);
      book = bookFromMock ?? null;
      sectionSummaries = [...(summariesFromMock ?? [])].sort((a, b) => a.spineIndex - b.spineIndex);
    }

    const bookId = book?.id ?? TEST_BOOK_ID;
    const params: ThreadContextParams = {
      threadId: "t1",
      messages: [],
      attachedHighlights: [
        { id: "h1", bookId, cfi: "epubcfi(/6/4!/4/2/1:0)", selectedText: "a pall falling over the land", color: "yellow", chapterLabel: "On dispersal", chapterHref: "OPS/chapter_05.html", createdAt: 0 },
      ],
      userMessage: "What does this mean?",
      bookTitle: book?.title ?? "Book",
      author: book?.author ?? "Unknown",
      bookId,
      bookSummary: book?.bookSummary ?? null,
      sectionSummaries: sectionSummaries.length > 0 ? sectionSummaries : undefined,
      scanStatus: (book?.smartScanStatus as "none" | "in_progress" | "done") ?? "none",
      bookStructureType: book?.bookStructureType ?? null,
      currentCfi: "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
    };

    const assembled = assembleThreadContext(params);
    expect(assembled.systemBlocks.length).toBeGreaterThan(0);

    const systemText = assembled.systemBlocks.map((b) => b.text).join("\n\n---\n\n");
    const outDir = path.join(process.cwd(), "MDs");
    const outPath = path.join(outDir, "SAMPLE_SYSTEM_PROMPT.md");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const source = fromDb ? "Data from real DB (MARGINALIA_DB_PATH or default app path)." : "Data from mocked DB (no real DB found).";
    const header = `<!-- Generated by npm run print-prompt. ${source} -->\n\n`;
    fs.writeFileSync(outPath, header + systemText, "utf8");

    expect(systemText).toContain("Marginalia");
    if (sectionSummaries.length > 0) {
      expect(systemText).toContain("SECTION INDEX");
    }
  });
});
