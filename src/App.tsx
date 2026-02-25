import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
import { DocumentLoader } from "@/libs/document";
import type { BookDoc, TOCItem } from "@/libs/document";
import type { BookNote } from "@/types/book";
import type { ReaderTheme } from "@/app/reader/utils/readerStyles";
import FoliateViewer from "@/app/reader/components/FoliateViewer";
import Library from "@/components/Library";
import {
  dbDeleteBook,
  dbDeleteBookmark,
  dbDeleteNote,
  dbGetAllBooks,
  dbGetBook,
  dbGetBookmarks,
  dbGetNotes,
  dbUpdateReadingProgress,
  dbUpsertBookmark,
  dbUpsertBook,
  dbUpsertNote,
  type StoredBookmark,
  type StoredBook,
} from "@/services/db";
import { BookOpenText, NotepadText } from "lucide-react";

function base64ToFile(base64: string, filename: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: "application/epub+zip" });
}

async function hashString(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function toDisplayString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry ?? "").trim()))
      .filter(Boolean);
    return parts.join(", ") || fallback;
  }
  if (value == null) return fallback;
  const asString = String(value).trim();
  return asString && asString !== "[object Object]" ? asString : fallback;
}

function formatBookmarkTimestamp(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "Recently saved";
  }
}

function buildBookmarkLocationLabel(args: {
  chapterLabel: string | null;
  pageLabel: string | null;
  pageCurrent: number | null;
  pageTotal: number | null;
}): string {
  const chapter = (args.chapterLabel || "").trim();
  const pageFromLabel = (args.pageLabel || "").trim();
  const pageFromNumbers =
    args.pageCurrent != null && args.pageTotal != null
      ? `Page ${args.pageCurrent + 1}/${args.pageTotal}`
      : "";
  const page = pageFromLabel || pageFromNumbers;
  if (chapter && page) return `${chapter} · ${page}`;
  if (chapter) return chapter;
  if (page) return page;
  return "Bookmark";
}

function App() {
  type PanelTab = "notes" | "bookmarks";
  type NotesFilter = "all" | "highlights" | "ai";
  type HighlightColorFilter = "all" | "yellow" | "blue" | "green" | "pink";
  const HIGHLIGHT_COLOR_HEX: Record<Exclude<HighlightColorFilter, "all">, string> = {
    yellow: "#e0d26c",
    blue: "#1f6feb",
    green: "#22a06b",
    pink: "#d94692",
  };
  const [epubPath, setEpubPath] = useState<string | null>(null);
  const [currentBookId, setCurrentBookId] = useState<string | null>(null);
  const [bookDoc, setBookDoc] = useState<BookDoc | null>(null);
  const [libraryBooks, setLibraryBooks] = useState<
    Array<StoredBook & { coverDataUrl?: string | null; isMissingFile?: boolean }>
  >([]);
  const [openingBookId, setOpeningBookId] = useState<string | null>(null);
  const [notes, setNotes] = useState<BookNote[]>([]);
  const [bookmarks, setBookmarks] = useState<StoredBookmark[]>([]);
  const [panelTab, setPanelTab] = useState<PanelTab>("notes");
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("all");
  const [highlightColorFilter, setHighlightColorFilter] = useState<HighlightColorFilter>("all");
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [jumpToCfi, setJumpToCfi] = useState<string | null>(null);
  const [deleteNoteCfi, setDeleteNoteCfi] = useState<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [scrollToNoteCfi, setScrollToNoteCfi] = useState<string | null>(null);
  const [currentTocHref, setCurrentTocHref] = useState<string | null>(null);
  const [currentTocLabel, setCurrentTocLabel] = useState<string | null>(null);
  const [currentPageLabel, setCurrentPageLabel] = useState<string | null>(null);
  const [currentPageCurrent, setCurrentPageCurrent] = useState<number | null>(null);
  const [currentPageTotal, setCurrentPageTotal] = useState<number | null>(null);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [error, setError] = useState<string | null>(null);
  const noteRefs = useRef<Record<string, HTMLDetailsElement | null>>({});
  const progressLastWriteAtRef = useRef(0);
  const progressTimeoutRef = useRef<number | null>(null);
  const pendingProgressRef = useRef<{ bookId: string; cfi: string; fraction: number } | null>(null);
  const progressWriteBlockRef = useRef<{ bookId: string; untilMs: number } | null>(null);
  const relocateDebounceTimerRef = useRef<number | null>(null);
  const relocatePendingPayloadRef = useRef<{
    bookId: string;
    cfi: string;
    fraction: number;
  } | null>(null);
  const chrome = useMemo(() => {
    if (theme === "dark") {
      return {
        appBg: "#121212",
        appFg: "#e8e8e8",
        panelBg: "rgba(22,22,22,0.96)",
        panelBorder: "rgba(255,255,255,0.16)",
        cardBg: "#1c1c1c",
        controlBg: "rgba(255,255,255,0.08)",
        controlBorder: "rgba(255,255,255,0.2)",
        controlFg: "#f3f3f3",
        muted: "#b4b4b4",
        badgeBg: "rgba(255,255,255,0.14)",
      };
    }
    if (theme === "sepia") {
      return {
        appBg: "#f4ecd8",
        appFg: "#4a3f2f",
        panelBg: "rgba(244,236,216,0.96)",
        panelBorder: "rgba(92,75,55,0.2)",
        cardBg: "rgba(255,255,255,0.6)",
        controlBg: "rgba(255,255,255,0.9)",
        controlBorder: "rgba(92,75,55,0.18)",
        controlFg: "#4a3f2f",
        muted: "#776652",
        badgeBg: "rgba(92,75,55,0.12)",
      };
    }
    return {
      appBg: "#faf9f7",
      appFg: "#222",
      panelBg: "rgba(255,255,255,0.97)",
      panelBorder: "rgba(0,0,0,0.12)",
      cardBg: "#fff",
      controlBg: "rgba(255,255,255,0.9)",
      controlBorder: "rgba(0,0,0,0.12)",
      controlFg: "#222",
      muted: "#666",
      badgeBg: "rgba(0,0,0,0.08)",
    };
  }, [theme]);

  const refreshLibrary = async () => {
    const books = await dbGetAllBooks();
    const hydrated = await Promise.all(
      books.map(async (book) => {
        let isMissingFile = false;
        try {
          isMissingFile = !(await exists(book.filePath));
        } catch {
          isMissingFile = false;
        }
        let coverDataUrl: string | null = null;
        if (book.coverPath) {
          try {
            const coverBase64 = await invoke<string>("read_file_base64", { path: book.coverPath });
            coverDataUrl = `data:image/jpeg;base64,${coverBase64}`;
          } catch {
            coverDataUrl = null;
          }
        }
        return { ...book, coverDataUrl, isMissingFile };
      })
    );
    setLibraryBooks(hydrated);
  };

  const flushPendingProgressWrite = async () => {
    if (progressTimeoutRef.current != null) {
      window.clearTimeout(progressTimeoutRef.current);
      progressTimeoutRef.current = null;
    }
    const payload = pendingProgressRef.current;
    if (!payload) return;
    console.debug("[Progress] flush pending write", payload);
    pendingProgressRef.current = null;
    progressLastWriteAtRef.current = Date.now();
    await dbUpdateReadingProgress(payload.bookId, payload.cfi, payload.fraction);
  };

  const openBookFromPath = async (path: string, preferredBookId?: string) => {
    await flushPendingProgressWrite();
    setError(null);
    setBookDoc(null);
    setNotes([]);
    setBookmarks([]);
    setIsNotesOpen(false);
    setIsTocOpen(false);
    setJumpToCfi(null);
    setCurrentTocHref(null);
    setCurrentTocLabel(null);
    setCurrentPageLabel(null);
    setCurrentPageCurrent(null);
    setCurrentPageTotal(null);
    setCurrentCfi(null);

    const bookId = preferredBookId ?? (await hashString(path));
    setOpeningBookId(bookId);
    try {
      const base64 = await invoke<string>("read_file_base64", { path });
      const filename = path.split(/[/\\]/).pop() ?? "book.epub";
      const file = base64ToFile(base64, filename);
      const { book } = await new DocumentLoader(file).open();
      const normalizedTitle = toDisplayString(book.metadata.title, filename);
      const normalizedAuthor = toDisplayString(book.metadata.author, "Unknown");

      const existing = await dbGetBook(bookId);
      let coverPath = existing?.coverPath ?? null;
      if (!coverPath) {
        try {
          const coverBlob = await book.getCover();
          if (coverBlob) {
            const coverBase64 = await blobToBase64(coverBlob);
            coverPath = await invoke<string>("save_cover_image", { bookId, bytesBase64: coverBase64 });
          }
        } catch {
          coverPath = null;
        }
      }

      const now = Date.now();
      await dbUpsertBook({
        id: bookId,
        title: normalizedTitle,
        author: normalizedAuthor,
        filePath: path,
        coverPath,
        progressFraction: existing?.progressFraction ?? 0,
        lastReadCfi: existing?.lastReadCfi ?? null,
        addedAt: existing?.addedAt ?? now,
        lastOpenedAt: now,
      });

      setCurrentBookId(bookId);
      // Prevent startup relocate events from overwriting saved progress with opening-position CFIs.
      progressWriteBlockRef.current = { bookId, untilMs: Date.now() + 3000 };
      setEpubPath(path);
      setJumpToCfi(existing?.lastReadCfi ?? null);
      const loadedNotes = await dbGetNotes(bookId);
      const loadedBookmarks = await dbGetBookmarks(bookId);
      setNotes(loadedNotes);
      setBookmarks(loadedBookmarks);
      setBookDoc(book);
      await refreshLibrary();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningBookId(null);
    }
  };

  const handleOpenBook = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
    await openBookFromPath(path);
  };

  useEffect(() => {
    void refreshLibrary();
  }, []);

  useEffect(() => {
    return () => {
      if (relocateDebounceTimerRef.current != null) {
        window.clearTimeout(relocateDebounceTimerRef.current);
        relocateDebounceTimerRef.current = null;
      }
      if (relocatePendingPayloadRef.current) {
        pendingProgressRef.current = relocatePendingPayloadRef.current;
        relocatePendingPayloadRef.current = null;
      }
      void flushPendingProgressWrite();
      if (progressTimeoutRef.current != null) {
        window.clearTimeout(progressTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!scrollToNoteCfi || !isNotesOpen) return;
    const node = noteRefs.current[scrollToNoteCfi];
    if (node) {
      node.open = true;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setScrollToNoteCfi(null);
    }
  }, [scrollToNoteCfi, isNotesOpen, notes]);

  const tocEntries = useMemo(() => bookDoc?.toc ?? [], [bookDoc?.toc]);
  const activeNotes = useMemo(() => notes.filter((note) => !note.deletedAt), [notes]);
  const filteredNotes = useMemo(() => {
    const isAiNote = (note: BookNote) => (note.aiConversation?.length ?? 0) > 0;
    const normalizeColor = (color: string | undefined): Exclude<HighlightColorFilter, "all"> => {
      if (color === "blue" || color === "green" || color === "pink") return color;
      return "yellow";
    };
    const applyColorFilter = (note: BookNote) =>
      highlightColorFilter === "all" || normalizeColor(note.color) === highlightColorFilter;

    if (notesFilter === "highlights") {
      return activeNotes.filter((note) => !isAiNote(note) && applyColorFilter(note));
    }
    if (notesFilter === "ai") return activeNotes.filter((note) => isAiNote(note));
    // In "All", keep AI notes visible and filter only highlight notes by color.
    return activeNotes.filter((note) => isAiNote(note) || applyColorFilter(note));
  }, [activeNotes, notesFilter, highlightColorFilter]);
  const isCurrentBookmarked = useMemo(
    () => !!currentCfi && bookmarks.some((bookmark) => bookmark.cfi === currentCfi),
    [bookmarks, currentCfi]
  );

  const RELOCATE_DEBOUNCE_MS = 200;

  const queueProgressWrite = (bookId: string, cfi: string, fraction: number) => {
    const now = Date.now();
    const elapsed = now - progressLastWriteAtRef.current;
    const minIntervalMs = 3000;
    pendingProgressRef.current = { bookId, cfi, fraction };
    console.debug("[Progress] queue", { bookId, cfi, fraction, elapsedMsSinceLastWrite: elapsed });

    const flush = () => {
      const payload = pendingProgressRef.current;
      if (!payload) return;
      pendingProgressRef.current = null;
      progressLastWriteAtRef.current = Date.now();
      console.debug("[Progress] flush throttled write", payload);
      void dbUpdateReadingProgress(payload.bookId, payload.cfi, payload.fraction);
    };

    if (elapsed >= minIntervalMs) {
      if (progressTimeoutRef.current != null) {
        window.clearTimeout(progressTimeoutRef.current);
        progressTimeoutRef.current = null;
      }
      flush();
      return;
    }

    if (progressTimeoutRef.current != null) return;
    const delay = minIntervalMs - elapsed;
    progressTimeoutRef.current = window.setTimeout(() => {
      progressTimeoutRef.current = null;
      flush();
    }, delay);
  };

  const handleAddNote = (note: BookNote) => {
    setNotes((prev) => [...prev, note]);
    if (currentBookId) {
      void dbUpsertNote(currentBookId, note);
    }
  };

  const handleUpdateNote = (note: BookNote) => {
    setNotes((prev) => prev.map((n) => (n.id === note.id ? note : n)));
    if (currentBookId) {
      if (note.deletedAt) {
        void dbDeleteNote(note.id);
      } else {
        void dbUpsertNote(currentBookId, note);
      }
    }
  };

  const handleDeleteNoteFromPanel = (note: BookNote) => {
    setDeleteNoteCfi(note.cfi);
    handleUpdateNote({
      ...note,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const handleToggleBookmark = () => {
    if (!currentBookId || !currentCfi) return;
    const existing = bookmarks.find((bookmark) => bookmark.cfi === currentCfi);
    if (existing) {
      setBookmarks((prev) => prev.filter((bookmark) => bookmark.id !== existing.id));
      void dbDeleteBookmark(existing.id);
      return;
    }
    const bookmark: StoredBookmark = {
      id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      bookId: currentBookId,
      cfi: currentCfi,
      chapterLabel: buildBookmarkLocationLabel({
        chapterLabel: currentTocLabel,
        pageLabel: currentPageLabel,
        pageCurrent: currentPageCurrent,
        pageTotal: currentPageTotal,
      }),
      createdAt: Date.now(),
    };
    setBookmarks((prev) => [bookmark, ...prev]);
    void dbUpsertBookmark(bookmark);
  };

  if (bookDoc) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          minWidth: "100%",
          minHeight: "100%",
          background: chrome.appBg,
          color: chrome.appFg,
        }}
      >
        <FoliateViewer
          bookKey={epubPath ?? "current"}
          bookDoc={bookDoc}
          config={{}}
          notes={notes}
          onAddNote={handleAddNote}
          onUpdateNote={handleUpdateNote}
          jumpToCfi={jumpToCfi}
          onJumpHandled={() => setJumpToCfi(null)}
          deleteNoteCfi={deleteNoteCfi}
          onDeleteNoteCfiHandled={() => setDeleteNoteCfi(null)}
          onOpenNoteFromHighlight={(cfi) => {
            setIsNotesOpen(true);
            setNotesFilter("all");
            setScrollToNoteCfi(cfi);
          }}
          onTocNavigateComplete={(payload) => {
            if (!currentBookId || !payload) return;
            if (relocateDebounceTimerRef.current != null) {
              window.clearTimeout(relocateDebounceTimerRef.current);
              relocateDebounceTimerRef.current = null;
            }
            relocatePendingPayloadRef.current = null;
            pendingProgressRef.current = {
              bookId: currentBookId,
              cfi: payload.cfi,
              fraction: payload.fraction,
            };
            void flushPendingProgressWrite();
          }}
          onRelocate={({ cfi, tocHref, tocLabel, pageLabel, pageCurrent, pageTotal }) => {
            const block = progressWriteBlockRef.current;
            const isProgressWriteBlocked =
              !!currentBookId &&
              block != null &&
              block.bookId === currentBookId &&
              Date.now() < block.untilMs;
            if (currentBookId && openingBookId !== currentBookId && !isProgressWriteBlocked) {
              const fraction =
                pageCurrent != null && pageTotal != null && pageTotal > 0
                  ? (pageCurrent + 1) / pageTotal
                  : 0;
              relocatePendingPayloadRef.current = {
                bookId: currentBookId,
                cfi,
                fraction,
              };
              if (relocateDebounceTimerRef.current != null) {
                window.clearTimeout(relocateDebounceTimerRef.current);
              }
              relocateDebounceTimerRef.current = window.setTimeout(() => {
                relocateDebounceTimerRef.current = null;
                const payload = relocatePendingPayloadRef.current;
                if (payload) {
                  relocatePendingPayloadRef.current = null;
                  queueProgressWrite(payload.bookId, payload.cfi, payload.fraction);
                }
              }, RELOCATE_DEBOUNCE_MS);
            }
            setCurrentCfi(cfi);
            setCurrentTocHref(tocHref ?? null);
            setCurrentTocLabel(tocLabel ?? null);
            setCurrentPageLabel(pageLabel ?? null);
            setCurrentPageCurrent(pageCurrent ?? null);
            setCurrentPageTotal(pageTotal ?? null);
          }}
          theme={theme}
          onThemeChange={setTheme}
          isCurrentBookmarked={isCurrentBookmarked}
          onToggleBookmark={handleToggleBookmark}
          onClose={() => {
            void flushPendingProgressWrite();
            progressWriteBlockRef.current = null;
            setBookDoc(null);
            setCurrentBookId(null);
            setNotes([]);
            setBookmarks([]);
            setCurrentCfi(null);
            void refreshLibrary();
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 88,
            left: 8,
            zIndex: 130,
          }}
        >
          <button
            type="button"
            onClick={() => setIsTocOpen((prev) => !prev)}
            aria-label={isTocOpen ? "Hide table of contents" : "Show table of contents"}
            title={isTocOpen ? "Hide table of contents" : "Show table of contents"}
            style={{
              width: 34,
              height: 34,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              border: `1px solid ${chrome.controlBorder}`,
              borderRadius: 8,
              background: chrome.controlBg,
              color: chrome.controlFg,
            }}
          >
            <BookOpenText size={16} />
          </button>
        </div>
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 92,
            zIndex: 130,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={() => setIsNotesOpen((prev) => !prev)}
            aria-label={isNotesOpen ? "Hide notes panel" : "Show notes panel"}
            title={isNotesOpen ? "Hide notes panel" : "Show notes panel"}
            style={{
              width: 34,
              height: 34,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              border: `1px solid ${chrome.controlBorder}`,
              borderRadius: 8,
              background: chrome.controlBg,
              color: chrome.controlFg,
            }}
          >
            <NotepadText size={16} />
          </button>
          <span
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 999,
              padding: "0 6px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              background: chrome.badgeBg,
              color: chrome.controlFg,
            }}
          >
            {activeNotes.length}
          </span>
        </div>
        {isNotesOpen && (
          <>
            <button
              type="button"
              aria-label="Close notes panel"
              onClick={() => setIsNotesOpen(false)}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 129,
                border: "none",
                background: "transparent",
                padding: 0,
                margin: 0,
              }}
            />
            <aside
              style={{
                position: "absolute",
                top: 44,
                right: 8,
                bottom: 8,
                width: 360,
                maxWidth: "45vw",
                zIndex: 130,
                borderRadius: 10,
                border: `1px solid ${chrome.panelBorder}`,
                background: chrome.panelBg,
                boxShadow: "0 6px 22px rgba(0,0,0,0.12)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                color: chrome.appFg,
              }}
              onClick={(e) => e.stopPropagation()}
              onWheelCapture={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  padding: "10px 12px",
                  borderBottom: `1px solid ${chrome.panelBorder}`,
                  fontSize: 13,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span>
                  {panelTab === "bookmarks"
                    ? `Bookmarks (${bookmarks.length})`
                    : `Notes (${activeNotes.length})`}
                </span>
                <button
                  type="button"
                  onClick={() => setIsNotesOpen(false)}
                  style={{
                    border: `1px solid ${chrome.controlBorder}`,
                    borderRadius: 6,
                    padding: "2px 8px",
                    background: chrome.controlBg,
                    color: chrome.controlFg,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Close
                </button>
              </div>
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: `1px solid ${chrome.panelBorder}`,
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {(
                  [
                    { key: "notes", label: `Notes (${activeNotes.length})` },
                    { key: "bookmarks", label: `Bookmarks (${bookmarks.length})` },
                  ] as const
                ).map((tab) => {
                  const active = panelTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setPanelTab(tab.key)}
                      style={{
                        border: `1px solid ${chrome.controlBorder}`,
                        borderRadius: 999,
                        padding: "3px 10px",
                        background: active ? "rgba(31,111,235,0.16)" : chrome.controlBg,
                        color: active ? "#0b4fb3" : chrome.controlFg,
                        fontSize: 12,
                        fontWeight: active ? 600 : 500,
                        cursor: "pointer",
                      }}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              {panelTab === "notes" && (
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${chrome.panelBorder}`,
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                {(
                  [
                    { key: "all", label: "All" },
                    { key: "highlights", label: "Highlights" },
                    { key: "ai", label: "AI Notes" },
                  ] as const
                ).map((option) => {
                  const active = notesFilter === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setNotesFilter(option.key)}
                      style={{
                        border: `1px solid ${chrome.controlBorder}`,
                        borderRadius: 999,
                        padding: "3px 10px",
                        background: active ? "rgba(31,111,235,0.16)" : chrome.controlBg,
                        color: active ? "#0b4fb3" : chrome.controlFg,
                        fontSize: 12,
                        fontWeight: active ? 600 : 500,
                        cursor: "pointer",
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
                {(notesFilter === "all" || notesFilter === "highlights") && (
                  <>
                    <span style={{ color: chrome.muted, fontSize: 12, margin: "4px 2px 0 6px" }}>|</span>
                    {(
                      ["all", "yellow", "blue", "green", "pink"] as const satisfies HighlightColorFilter[]
                    ).map((colorFilter) => {
                      const active = highlightColorFilter === colorFilter;
                      const isAll = colorFilter === "all";
                      return (
                        <button
                          key={colorFilter}
                          type="button"
                          onClick={() => setHighlightColorFilter(colorFilter)}
                          title={isAll ? "Any highlight color" : `Only ${colorFilter} highlights`}
                          style={{
                            border: `1px solid ${chrome.controlBorder}`,
                            borderRadius: 999,
                            padding: isAll ? "3px 10px" : "3px 8px",
                            minWidth: isAll ? undefined : 24,
                            height: 24,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: active ? "rgba(31,111,235,0.16)" : chrome.controlBg,
                            color: active ? "#0b4fb3" : chrome.controlFg,
                            fontSize: 12,
                            fontWeight: active ? 600 : 500,
                            cursor: "pointer",
                          }}
                        >
                          {isAll ? (
                            "Any color"
                          ) : (
                            <span
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: "999px",
                                background: HIGHLIGHT_COLOR_HEX[colorFilter],
                                border: "1px solid rgba(0,0,0,0.2)",
                              }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </>
                )}
                </div>
              )}
              <div style={{ padding: 10, overflow: "auto", fontSize: 13, lineHeight: 1.45 }}>
                {panelTab === "bookmarks" ? (
                  bookmarks.length === 0 ? (
                    <p style={{ margin: 0, color: chrome.muted }}>No bookmarks yet.</p>
                  ) : (
                    bookmarks.map((bookmark) => (
                      <div
                        key={bookmark.id}
                        style={{
                          marginBottom: 8,
                          border: `1px solid ${chrome.panelBorder}`,
                          borderRadius: 8,
                          padding: "8px 10px",
                          background: chrome.cardBg,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                            {bookmark.chapterLabel || "Bookmark"}
                          </div>
                          <div style={{ color: chrome.muted, fontSize: 11 }}>
                            Saved {formatBookmarkTimestamp(bookmark.createdAt)}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => setJumpToCfi(bookmark.cfi)}
                            style={{
                              border: `1px solid ${chrome.controlBorder}`,
                              borderRadius: 6,
                              padding: "4px 8px",
                              background: chrome.controlBg,
                              color: chrome.controlFg,
                              cursor: "pointer",
                              fontSize: 12,
                            }}
                          >
                            Go to
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setBookmarks((prev) =>
                                prev.filter((existingBookmark) => existingBookmark.id !== bookmark.id)
                              );
                              void dbDeleteBookmark(bookmark.id);
                            }}
                            style={{
                              border: `1px solid ${chrome.controlBorder}`,
                              borderRadius: 6,
                              padding: "4px 8px",
                              background: chrome.controlBg,
                              color: "#b42318",
                              cursor: "pointer",
                              fontSize: 12,
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )
                ) : filteredNotes.length === 0 ? (
                  <p style={{ margin: 0, color: chrome.muted }}>
                    {activeNotes.length === 0
                      ? 'No saved notes yet. Select text and click "Save as note" in the AI panel.'
                      : "No notes in this filter."}
                  </p>
                ) : (
                  filteredNotes
                    .slice()
                    .reverse()
                    .map((note) => {
                      const isAiNote = (note.aiConversation?.length ?? 0) > 0;
                      const noteColor =
                        note.color === "blue" || note.color === "green" || note.color === "pink"
                          ? note.color
                          : "yellow";
                      const highlightHex = HIGHLIGHT_COLOR_HEX[noteColor];
                      return (
                        <details
                          key={note.id}
                          ref={(el) => {
                            noteRefs.current[note.cfi] = el;
                          }}
                          style={{
                            marginBottom: 8,
                            border: `1px solid ${isAiNote ? "rgba(31,111,235,0.32)" : chrome.panelBorder}`,
                            borderRadius: 8,
                            padding: "8px 10px",
                            background: isAiNote
                              ? theme === "dark"
                                ? "rgba(31,111,235,0.1)"
                                : "rgba(31,111,235,0.06)"
                              : theme === "dark"
                                ? "rgba(255,255,255,0.02)"
                                : chrome.cardBg,
                          }}
                        >
                          <summary
                            style={{
                              cursor: "pointer",
                              fontWeight: 600,
                              display: "flex",
                              alignItems: "flex-start",
                              justifyContent: "space-between",
                              gap: 8,
                            }}
                          >
                            <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span
                                  aria-hidden="true"
                                  style={{
                                    width: 9,
                                    height: 9,
                                    borderRadius: "999px",
                                    flexShrink: 0,
                                    background: isAiNote ? "#1f6feb" : highlightHex,
                                    border: "1px solid rgba(0,0,0,0.25)",
                                  }}
                                />
                                <span>{(note.selectedText ?? note.text ?? "Untitled note").slice(0, 90)}</span>
                              </span>
                              <span
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  flexWrap: "wrap",
                                  fontWeight: 500,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 11,
                                    borderRadius: 999,
                                    padding: "2px 8px",
                                    background:
                                      theme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
                                    color: chrome.muted,
                                  }}
                                >
                                  {`Chapter: ${note.chapterLabel ?? "Unknown"}`}
                                </span>
                                <span
                                  style={{
                                    fontSize: 11,
                                    borderRadius: 999,
                                    padding: "2px 8px",
                                    background:
                                      theme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
                                    color: chrome.muted,
                                  }}
                                >
                                  {`Page: ${
                                    note.pageLabel ??
                                    (note.pageCurrent != null && note.pageTotal != null
                                      ? `${note.pageCurrent + 1}/${note.pageTotal}`
                                      : "—")
                                  }`}
                                </span>
                              </span>
                            </span>
                            <span
                              style={{
                                flexShrink: 0,
                                borderRadius: 999,
                                padding: "2px 8px",
                                fontSize: 11,
                                fontWeight: 700,
                                background: isAiNote
                                  ? "rgba(31,111,235,0.18)"
                                  : `${highlightHex}${theme === "dark" ? "44" : "33"}`,
                                color: isAiNote ? "#0b4fb3" : theme === "dark" ? "#f3f3f3" : "#7a5d00",
                              }}
                            >
                              {isAiNote ? "AI Note" : "Highlight"}
                            </span>
                          </summary>
                          <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                            <div
                              style={{
                                padding: "6px 8px",
                                borderLeft: `3px solid ${isAiNote ? "#1f6feb" : highlightHex}`,
                                background:
                                  theme === "dark" ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.03)",
                                marginBottom: 8,
                              }}
                            >
                              {note.selectedText ?? note.text ?? "(no selected text)"}
                            </div>
                            {isAiNote ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {note.aiConversation?.map((m, idx) => (
                                  <div
                                    key={`${note.id}-${idx}`}
                                    style={{
                                      alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                                      maxWidth: "95%",
                                      padding: "6px 8px",
                                      borderRadius: 8,
                                      background:
                                        m.role === "user" ? "rgba(31,111,235,0.12)" : "rgba(0,0,0,0.05)",
                                    }}
                                  >
                                    <div style={{ fontSize: 11, color: chrome.muted, marginBottom: 2 }}>
                                      {m.role === "user" ? "You" : "Claude"}
                                    </div>
                                    <div>{m.content}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div>{note.note || "(highlight only — no AI response saved)"}</div>
                            )}
                            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setJumpToCfi(note.cfi);
                                }}
                                style={{
                                  padding: "5px 8px",
                                  fontSize: 12,
                                  border: "1px solid rgba(0,0,0,0.12)",
                                  borderRadius: 6,
                                  background: chrome.controlBg,
                                  color: chrome.controlFg,
                                  cursor: "pointer",
                                }}
                              >
                                Go to highlight
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDeleteNoteFromPanel(note);
                                }}
                                style={{
                                  padding: "5px 8px",
                                  fontSize: 12,
                                  border: "1px solid rgba(0,0,0,0.12)",
                                  borderRadius: 6,
                                  background: chrome.controlBg,
                                  color: "#b42318",
                                  cursor: "pointer",
                                }}
                              >
                                {isAiNote ? "Delete AI note" : "Delete highlight"}
                              </button>
                            </div>
                          </div>
                        </details>
                      );
                    })
                )}
              </div>
            </aside>
          </>
        )}
        {isTocOpen && (
          <aside
            style={{
              position: "absolute",
              top: 44,
              left: 8,
              bottom: 8,
              width: 320,
              maxWidth: "42vw",
              zIndex: 130,
              borderRadius: 10,
              border: `1px solid ${chrome.panelBorder}`,
              background: chrome.panelBg,
              boxShadow: "0 6px 22px rgba(0,0,0,0.12)",
              overflow: "auto",
              padding: 10,
              color: chrome.appFg,
            }}
            onClick={(e) => e.stopPropagation()}
            onWheelCapture={(e) => e.stopPropagation()}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Table of contents</span>
              <button
                type="button"
                onClick={() => setIsTocOpen(false)}
                style={{
                  border: `1px solid ${chrome.controlBorder}`,
                  borderRadius: 6,
                  padding: "2px 8px",
                  background: chrome.controlBg,
                  color: chrome.controlFg,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Close
              </button>
            </div>
            {tocEntries.length === 0 ? (
              <div style={{ fontSize: 12, color: chrome.muted }}>No TOC available</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {tocEntries.map((item, idx) => {
                  const renderItem = (toc: TOCItem, depth: number) => {
                    const active =
                      (currentTocHref && toc.href === currentTocHref) ||
                      (currentTocLabel && toc.label === currentTocLabel);
                    return (
                      <div key={`${toc.href}-${depth}-${toc.id}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setJumpToCfi(toc.href);
                            setIsTocOpen(false);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 8px",
                            marginLeft: depth * 10,
                            borderRadius: 6,
                            border: "none",
                            background: active ? "rgba(31,111,235,0.15)" : "transparent",
                            color: active ? "#0b4fb3" : chrome.appFg,
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          {toc.label || `Section ${idx + 1}`}
                        </button>
                        {toc.subitems?.map((sub) => renderItem(sub, depth + 1))}
                      </div>
                    );
                  };
                  return renderItem(item, 0);
                })}
              </div>
            )}
          </aside>
        )}
        <div
          aria-live="polite"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 10,
            transform: "translateX(-50%)",
            zIndex: 120,
            padding: "4px 10px",
            borderRadius: 999,
            border: `1px solid ${chrome.controlBorder}`,
            background: chrome.controlBg,
            color: chrome.controlFg,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          {currentPageLabel
            ? `Page ${currentPageLabel}`
            : currentPageCurrent != null && currentPageTotal != null
              ? `Page ${currentPageCurrent + 1}/${currentPageTotal}`
              : "Page —"}
        </div>
      </div>
    );
  }

  return (
    <>
      <Library
        books={libraryBooks}
        onOpenBook={() => void handleOpenBook()}
        onSelectBook={(book) => void openBookFromPath(book.filePath, book.id)}
        onDeleteBook={async (book) => {
          await dbDeleteBook(book.id);
          await refreshLibrary();
        }}
        openingBookId={openingBookId}
      />
      {error && (
        <p
          style={{
            position: "fixed",
            bottom: 16,
            left: 16,
            margin: 0,
            color: "crimson",
            background: "rgba(255,255,255,0.9)",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(0,0,0,0.1)",
          }}
        >
          {error}
        </p>
      )}
    </>
  );
}

export default App;
