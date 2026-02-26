import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
import { DocumentLoader } from "@/libs/document";
import type { BookDoc, TOCItem } from "@/libs/document";
import type { Highlight, Thread, ThreadMessage } from "@/types/book";
import type { ReaderTheme } from "@/app/reader/utils/readerStyles";
import FoliateViewer from "@/app/reader/components/FoliateViewer";
import Library from "@/components/Library";
import {
  dbArchiveThread,
  dbAttachHighlightToThread,
  dbCreateThread,
  dbGetHighlightsForThread,
  dbGetStandaloneHighlights,
  dbGetThreadMessages,
  dbGetThreads,
  dbSaveThreadMessage,
  dbUpdateThreadTitle,
  dbDeleteBook,
  dbDeleteBookmark,
  dbDeleteHighlight,
  dbGetAllBooks,
  dbGetBook,
  dbGetBookmarks,
  dbGetHighlights,
  dbUpdateReadingProgress,
  dbUpsertBookmark,
  dbUpsertBook,
  dbUpsertHighlight,
  memoryEnsureDirs,
  memoryListBooks,
  memoryReadBook,
  memoryReadReader,
  memoryWriteBook,
  memoryWriteReader,
  type StoredBookmark,
  type StoredBook,
} from "@/services/db";
import {
  compactThreadToJournal,
  extractReaderProfile,
  formatReaderMd,
  parseReaderMd,
} from "@/services/compaction";
import { askClaudeThread, generateThreadTitle } from "@/services/claude";
import { ArrowLeft, ArrowRight, BookOpenText, NotepadText } from "lucide-react";

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
  type PanelTab = "threads" | "highlights" | "bookmarks";
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
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThreadMessages, setActiveThreadMessages] = useState<ThreadMessage[]>([]);
  const [activeThreadHighlights, setActiveThreadHighlights] = useState<Highlight[]>([]);
  const [standaloneHighlights, setStandaloneHighlights] = useState<Highlight[]>([]);
  const [bookmarks, setBookmarks] = useState<StoredBookmark[]>([]);
  const [panelTab, setPanelTab] = useState<PanelTab>("threads");
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("all");
  const [highlightColorFilter, setHighlightColorFilter] = useState<HighlightColorFilter>("all");
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [jumpToCfi, setJumpToCfi] = useState<string | null>(null);
  const [backCfi, setBackCfi] = useState<string | null>(null);
  const currentCfiRef = useRef<string | null>(null);
  const [deleteHighlightCfi, setDeleteHighlightCfi] = useState<string | null>(null);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [scrollToNoteCfi, setScrollToNoteCfi] = useState<string | null>(null);
  const [currentTocHref, setCurrentTocHref] = useState<string | null>(null);
  const [currentTocLabel, setCurrentTocLabel] = useState<string | null>(null);
  const [currentPageLabel, setCurrentPageLabel] = useState<string | null>(null);
  const [currentPageCurrent, setCurrentPageCurrent] = useState<number | null>(null);
  const [currentPageTotal, setCurrentPageTotal] = useState<number | null>(null);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [error, setError] = useState<string | null>(null);
  const [threadChatInput, setThreadChatInput] = useState("");
  const [threadChatAsking, setThreadChatAsking] = useState(false);
  const [threadChatError, setThreadChatError] = useState<string | null>(null);
  const threadChatInputRef = useRef<HTMLInputElement | null>(null);
  const [savingSession, setSavingSession] = useState(false);
  const [archivingThreadId, setArchivingThreadId] = useState<string | null>(null);
  const [archiveToast, setArchiveToast] = useState<string | null>(null);
  const archiveToastTimeoutRef = useRef<number | null>(null);
  /** Excerpt to attach to the very next user message (set when user clicks "Add to thread"). */
  const [pendingMessageExcerpt, setPendingMessageExcerpt] = useState<{
    text: string;
    cfi: string;
    chapter: string | null;
    color: string;
    page: string | null;
  } | null>(null);
  /** Message IDs whose excerpt card is expanded (click toggles). */
  const [excerptExpandedIds, setExcerptExpandedIds] = useState<Set<string>>(new Set());
  const getSectionTextRef = useRef<((tocHref?: string) => string) | null>(null);
  const highlightRefs = useRef<Record<string, HTMLDetailsElement | null>>({});
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
    setHighlights([]);
    setThreads([]);
    setActiveThreadId(null);
    setActiveThreadMessages([]);
    setActiveThreadHighlights([]);
    setStandaloneHighlights([]);
    setBookmarks([]);
    setIsNotesOpen(false);
    setIsTocOpen(false);
    setJumpToCfi(null);
    setBackCfi(null);
    currentCfiRef.current = null;
    setCurrentTocHref(null);
    setCurrentTocLabel(null);
    setCurrentPageLabel(null);
    setCurrentPageCurrent(null);
    setCurrentPageTotal(null);
    setCurrentCfi(null);

    const bookId = preferredBookId ?? (await hashString(path));
    setOpeningBookId(bookId);
    const OPEN_BOOK_TIMEOUT_MS = 120_000; // 2 minutes for large EPUBs
    try {
      console.log("[OpenBook] Starting open", { path: path.slice(-60), bookId });
      const readWithTimeout = invoke<string>("read_file_base64", { path });
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Opening book timed out (2 min). The file may be very large or on a slow drive.")), OPEN_BOOK_TIMEOUT_MS);
      });
      const base64 = await Promise.race([readWithTimeout, timeoutPromise]);
      const sizeBytes = Math.round((base64.length * 3) / 4);
      console.log("[OpenBook] File read", { sizeBytes, base64Length: base64.length });
      const filename = path.split(/[/\\]/).pop() ?? "book.epub";
      const file = base64ToFile(base64, filename);
      console.log("[OpenBook] Parsing EPUB…");
      const { book } = await new DocumentLoader(file).open();
      console.log("[OpenBook] EPUB parsed", { sectionCount: book.sections?.length ?? 0 });
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
      const [loadedHighlights, loadedThreads, loadedStandalone] = await Promise.all([
        dbGetHighlights(bookId),
        dbGetThreads(bookId),
        dbGetStandaloneHighlights(bookId),
      ]);
      setHighlights(loadedHighlights);
      setThreads(loadedThreads);
      setStandaloneHighlights(loadedStandalone);
      setActiveThreadId(loadedThreads[0]?.id ?? null);
      setBookmarks(await dbGetBookmarks(bookId));
      setBookDoc(book);
      console.log("[OpenBook] Done");
      await refreshLibrary();
    } catch (e) {
      console.error("[OpenBook] Error", e);
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timed out|os error 60|ETIMEDOUT/i.test(msg);
      setError(
        isTimeout
          ? "Opening the file timed out. If it’s in iCloud or a network folder, copy it to a local folder (e.g. Desktop) and try again."
          : msg
      );
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
    currentCfiRef.current = currentCfi;
  }, [currentCfi]);

  useEffect(() => {
    void refreshLibrary();
  }, []);

  useEffect(() => {
    void memoryEnsureDirs();
  }, []);

  useEffect(() => {
    setPendingMessageExcerpt(null);
    if (!activeThreadId || !currentBookId) {
      setActiveThreadMessages([]);
      setActiveThreadHighlights([]);
      setThreadChatError(null);
      return;
    }
    setThreadChatError(null);
    Promise.all([
      dbGetThreadMessages(activeThreadId),
      dbGetHighlightsForThread(activeThreadId),
    ]).then(([messages, threadHighlights]) => {
      setActiveThreadMessages(messages);
      setActiveThreadHighlights(threadHighlights);
    });
  }, [activeThreadId, currentBookId]);

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
      if (archiveToastTimeoutRef.current != null) {
        window.clearTimeout(archiveToastTimeoutRef.current);
        archiveToastTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("marginalia-prepare-close", async () => {
      if (
        activeThreadId &&
        currentBookId &&
        bookDoc &&
        activeThreadMessages.length >= 3
      ) {
        setSavingSession(true);
        const thread = threads.find((t) => t.id === activeThreadId);
        try {
          await runCompactionForThread({
            threadId: activeThreadId,
            threadTitle: thread?.title ?? "Discussion",
            threadMessages: activeThreadMessages,
            bookId: currentBookId,
            bookTitle: bookDoc.metadata?.title ?? "Book",
            author: bookDoc.metadata?.author ?? "",
          });
        } finally {
          setSavingSession(false);
        }
      }
      await invoke("allow_window_close");
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, [
    activeThreadId,
    activeThreadMessages,
    bookDoc,
    currentBookId,
    threads,
  ]);

  useEffect(() => {
    if (!scrollToNoteCfi || !isNotesOpen) return;
    const node = highlightRefs.current[scrollToNoteCfi];
    if (node) {
      node.open = true;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setScrollToNoteCfi(null);
    }
  }, [scrollToNoteCfi, isNotesOpen, highlights]);

  const tocEntries = useMemo(() => bookDoc?.toc ?? [], [bookDoc?.toc]);
  const filteredHighlights = useMemo(() => {
    const normalizeColor = (color: string | undefined): Exclude<HighlightColorFilter, "all"> => {
      if (color === "blue" || color === "green" || color === "pink") return color;
      return "yellow";
    };
    const applyColorFilter = (h: Highlight) =>
      highlightColorFilter === "all" || normalizeColor(h.color) === highlightColorFilter;
    if (notesFilter === "highlights") return highlights.filter(applyColorFilter);
    if (notesFilter === "ai") return []; // No per-highlight AI in Phase 23; threads in Phase 24
    return highlights.filter(applyColorFilter);
  }, [highlights, notesFilter, highlightColorFilter]);
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

  const handleAddHighlight = (highlight: Highlight) => {
    setHighlights((prev) => [...prev, highlight]);
    setStandaloneHighlights((prev) => [...prev, highlight]);
    void dbUpsertHighlight(highlight);
  };

  const handleUpdateHighlight = (highlight: Highlight) => {
    setHighlights((prev) => prev.map((h) => (h.id === highlight.id ? highlight : h)));
    void dbUpsertHighlight(highlight);
  };

  const handleDeleteHighlightFromPanel = (highlight: Highlight) => {
    setHighlights((prev) => prev.filter((h) => h.id !== highlight.id));
    setStandaloneHighlights((prev) => prev.filter((h) => h.id !== highlight.id));
    void dbDeleteHighlight(highlight.id);
    setDeleteHighlightCfi(highlight.cfi);
  };

  const newThreadId = () =>
    `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const createNewThread = (): Thread | undefined => {
    if (!currentBookId) return undefined;
    const now = Date.now();
    const thread: Thread = {
      id: newThreadId(),
      bookId: currentBookId,
      title: undefined,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    void dbCreateThread(thread).then(() => {
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setActiveThreadMessages([]);
      setActiveThreadHighlights([]);
    });
    return thread;
  };

  const handleOpenAiPanel = (
    selection: { cfi: string; selectedText: string; chapterLabel?: string; chapterHref?: string },
    targetThreadId: string | null
  ) => {
    if (!currentBookId) return;
    const highlight: Highlight = {
      id: `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      bookId: currentBookId,
      cfi: selection.cfi,
      selectedText: selection.selectedText,
      color: "yellow",
      chapterLabel: selection.chapterLabel,
      chapterHref: selection.chapterHref,
      createdAt: Date.now(),
    };
    setHighlights((prev) => [...prev, highlight]);
    void dbUpsertHighlight(highlight);
    const threadId = targetThreadId === null ? createNewThread()?.id : targetThreadId;
    if (!threadId) return;
    setIsNotesOpen(true);
    setActiveThreadId(threadId);
    void dbAttachHighlightToThread(threadId, highlight.id).then(() => {
      setStandaloneHighlights((prev) => prev.filter((h) => h.id !== highlight.id));
      dbGetHighlightsForThread(threadId).then(setActiveThreadHighlights);
    });
    setPendingMessageExcerpt({
      text: selection.selectedText,
      cfi: selection.cfi,
      chapter: selection.chapterLabel ?? null,
      color: "yellow",
      page: currentPageLabel ?? null,
    });
    setPanelTab("threads");
  };

  const handleMessagePair = (
    userContent: string,
    assistantContent: string,
    excerpt?: { text: string; cfi: string | null; chapter: string | null; color: string; page: string | null }
  ) => {
    const threadId = activeThreadId;
    if (!threadId) return;
    const now = Date.now();
    const userMsg: ThreadMessage = {
      id: `msg-${now}-u`,
      threadId,
      role: "user",
      content: userContent,
      createdAt: now,
      ...(excerpt?.text
        ? {
            excerptText: excerpt.text,
            excerptCfi: excerpt.cfi ?? null,
            excerptChapter: excerpt.chapter ?? null,
            excerptColor: excerpt.color ?? "yellow",
            excerptPage: excerpt.page ?? null,
          }
        : {}),
    };
    const assistantMsg: ThreadMessage = {
      id: `msg-${now}-a`,
      threadId,
      role: "assistant",
      content: assistantContent,
      createdAt: now,
    };
    void dbSaveThreadMessage(userMsg).then(() =>
      dbSaveThreadMessage(assistantMsg).then(async () => {
        const newMessages = [...activeThreadMessages, userMsg, assistantMsg];
        setActiveThreadMessages(newMessages);
        const wasFirst = activeThreadMessages.length === 0;
        if (wasFirst && bookDoc) {
          const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
          if (apiKey) {
            generateThreadTitle(userContent.slice(0, 300), apiKey).then((raw) => {
              const firstLine = raw.split(/\n/)[0].trim();
              const words = firstLine.split(/\s+/).filter(Boolean);
              const looksLikeTitle =
                firstLine.length > 0 &&
                firstLine.length <= 60 &&
                words.length <= 10 &&
                !firstLine.endsWith("?") &&
                !/^(I |Could you|Would you|Please|I'd be)/i.test(firstLine);
              const fallbackWords = userContent.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
              const title = looksLikeTitle ? firstLine : (fallbackWords && fallbackWords.length <= 50 ? fallbackWords : "Discussion");
              if (title) {
                void dbUpdateThreadTitle(threadId, title);
                setThreads((prev) =>
                  prev.map((t) => (t.id === threadId ? { ...t, title } : t))
                );
              }
            });
          }
        }
        if (currentBookId && bookDoc && newMessages.length >= 40) {
          const thread = threads.find((t) => t.id === threadId);
          await runCompactionForThread({
            threadId,
            threadTitle: thread?.title ?? "Discussion",
            threadMessages: newMessages,
            bookId: currentBookId,
            bookTitle: bookDoc.metadata?.title ?? "Book",
            author: bookDoc.metadata?.author ?? "",
          });
        }
      })
    );
  };

  const runCompactionForThread = async (params: {
    threadId: string;
    threadTitle: string;
    threadMessages: ThreadMessage[];
    bookId: string;
    bookTitle: string;
    author: string;
  }) => {
    const { threadId, threadTitle, threadMessages, bookId, bookTitle, author } = params;
    if (threadMessages.length === 0) return;
    try {
      const currentBook = (await memoryReadBook(bookId)) ?? "";
      const entry = await compactThreadToJournal({
        bookTitle,
        author,
        threadTitle: threadTitle ?? "Discussion",
        threadDate: new Date().toISOString().slice(0, 10),
        threadMessages,
        existingMemory: currentBook || null,
      });
      if (!entry) return;
      const newSection = `\n\n## ${threadTitle ?? "Discussion"} — ${new Date().toISOString().slice(0, 10)}\n${entry}`;
      await memoryWriteBook(bookId, currentBook + newSection);

      const readerContent = (await memoryReadReader()) ?? "";
      const { threadsClosed, body } = parseReaderMd(readerContent);
      const nextClosed = threadsClosed + 1;
      if (nextClosed % 5 === 0) {
        const bookIds = await memoryListBooks();
        const journalsByTitle = await Promise.all(
          bookIds.map(async (id) => {
            const content = await memoryReadBook(id);
            const book = libraryBooks.find((b) => b.id === id);
            return { title: book?.title ?? id, content: content ?? "" };
          })
        );
        const newProfile = await extractReaderProfile({
          journalsByTitle,
          existingProfile: body,
        });
        await memoryWriteReader(formatReaderMd({ threadsClosed: nextClosed, body: newProfile }));
      } else {
        await memoryWriteReader(formatReaderMd({ threadsClosed: nextClosed, body }));
      }
    } catch (e) {
      console.error("[Compaction]", e);
    }
  };

  const handleArchiveThread = async (threadId: string) => {
    setArchivingThreadId(threadId);
    if (archiveToastTimeoutRef.current != null) {
      window.clearTimeout(archiveToastTimeoutRef.current);
      archiveToastTimeoutRef.current = null;
    }
    try {
      const thread = threads.find((t) => t.id === threadId);
      if (thread && currentBookId && bookDoc) {
        const [msgs, _highlights] = await Promise.all([
          dbGetThreadMessages(threadId),
          dbGetHighlightsForThread(threadId),
        ]);
        await runCompactionForThread({
          threadId,
          threadTitle: thread.title ?? "Discussion",
          threadMessages: msgs,
          bookId: currentBookId,
          bookTitle: bookDoc.metadata?.title ?? "Book",
          author: bookDoc.metadata?.author ?? "",
        });
      }
      await dbArchiveThread(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (activeThreadId === threadId) setActiveThreadId(null);
      setArchiveToast("Thread archived");
      archiveToastTimeoutRef.current = window.setTimeout(() => {
        setArchiveToast(null);
        archiveToastTimeoutRef.current = null;
      }, 2500);
    } catch (e) {
      console.error("[Archive]", e);
      setArchiveToast("Archive failed");
      archiveToastTimeoutRef.current = window.setTimeout(() => {
        setArchiveToast(null);
        archiveToastTimeoutRef.current = null;
      }, 3000);
    } finally {
      setArchivingThreadId(null);
    }
  };

  const handleUpdateThreadTitle = (threadId: string, title: string) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, title } : t))
    );
    void dbUpdateThreadTitle(threadId, title);
  };

  const handleThreadChatSend = async () => {
    const userMessage = threadChatInput.trim() || "What can you tell me about the passages I've highlighted?";
    if (!activeThreadId || !currentBookId || !bookDoc || threadChatAsking) return;
    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) {
      setThreadChatError("Add VITE_ANTHROPIC_API_KEY to .env and restart.");
      return;
    }
    setThreadChatAsking(true);
    setThreadChatError(null);
    setThreadChatInput("");
    try {
      const [bookMemory, readerProfile] = await Promise.all([
        memoryReadBook(currentBookId),
        memoryReadReader(),
      ]);
      const chapterText = getSectionTextRef.current?.(currentTocHref ?? undefined)?.trim() ?? "";
      const currentPassage =
        chapterText ||
        (activeThreadHighlights.length > 0
          ? activeThreadHighlights[activeThreadHighlights.length - 1].selectedText
          : "");
      const passageForThisMessage = pendingMessageExcerpt?.text ?? currentPassage;
      const result = await askClaudeThread(
        {
          threadId: activeThreadId,
          messages: activeThreadMessages,
          attachedHighlights: activeThreadHighlights,
          currentPassage: passageForThisMessage,
          userMessage,
          bookTitle: bookDoc.metadata?.title ?? "Book",
          author: bookDoc.metadata?.author ?? "",
          bookId: currentBookId,
          bookMemory: bookMemory ?? undefined,
          readerProfile: readerProfile ?? undefined,
        },
        apiKey
      );
      const lastHighlight = activeThreadHighlights[activeThreadHighlights.length - 1];
      const excerpt = (() => {
        const page = currentPageLabel ?? null;
        if (pendingMessageExcerpt)
          return {
            text: pendingMessageExcerpt.text,
            cfi: pendingMessageExcerpt.cfi,
            chapter: pendingMessageExcerpt.chapter,
            color: pendingMessageExcerpt.color,
            page: pendingMessageExcerpt.page ?? page,
          };
        if (!passageForThisMessage) return undefined;
        return passageForThisMessage === chapterText
          ? { text: passageForThisMessage, cfi: currentCfi ?? null, chapter: currentTocLabel ?? null, color: "yellow" as const, page }
          : {
              text: passageForThisMessage,
              cfi: currentCfi ?? lastHighlight?.cfi ?? null,
              chapter: currentTocLabel ?? lastHighlight?.chapterLabel ?? null,
              color: (lastHighlight?.color === "blue" || lastHighlight?.color === "green" || lastHighlight?.color === "pink" ? lastHighlight.color : "yellow") as string,
              page,
            };
      })();
      setPendingMessageExcerpt(null);
      handleMessagePair(userMessage, result.answer ?? "", excerpt);
    } catch (e) {
      setThreadChatError(e instanceof Error ? e.message : String(e));
    } finally {
      setThreadChatAsking(false);
      threadChatInputRef.current?.focus();
    }
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
        {savingSession && (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 9999,
              padding: "12px 16px",
              background: chrome.panelBg,
              borderBottom: `1px solid ${chrome.panelBorder}`,
              textAlign: "center",
              fontSize: 13,
              color: chrome.appFg,
            }}
          >
            Saving your reading session…
          </div>
        )}
        <FoliateViewer
          bookKey={epubPath ?? "current"}
          bookDoc={bookDoc}
          bookId={currentBookId}
          config={{}}
          highlights={highlights}
          onAddHighlight={handleAddHighlight}
          onUpdateHighlight={handleUpdateHighlight}
          onDeleteHighlight={(id) => {
            const h = highlights.find((x) => x.id === id);
            if (h) handleDeleteHighlightFromPanel(h);
          }}
          jumpToCfi={jumpToCfi}
          onJumpHandled={() => setJumpToCfi(null)}
          deleteNoteCfi={deleteHighlightCfi}
          onDeleteNoteCfiHandled={() => setDeleteHighlightCfi(null)}
          onOpenNoteFromHighlight={(cfi) => {
            setIsNotesOpen(true);
            setNotesFilter("all");
            setScrollToNoteCfi(cfi);
          }}
          onOpenAiPanel={handleOpenAiPanel}
          threads={threads}
          onRegisterGetSectionText={(fn) => {
            getSectionTextRef.current = fn;
          }}
          onMessagePair={handleMessagePair}
          threadContext={
            activeThreadId && currentBookId
              ? {
                  threadId: activeThreadId,
                  messages: activeThreadMessages,
                  highlights: activeThreadHighlights,
                  bookId: currentBookId,
                }
              : null
          }
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
            currentCfiRef.current = cfi;
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
            setHighlights([]);
            setBookmarks([]);
            setCurrentCfi(null);
            setBackCfi(null);
            currentCfiRef.current = null;
            void refreshLibrary();
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 88,
            left: 8,
            zIndex: 130,
            display: "flex",
            alignItems: "center",
            gap: 6,
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
        {backCfi && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 130,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setJumpToCfi(backCfi);
                setBackCfi(null);
              }}
              aria-label="Go back to previous page"
              title="Go back to previous page"
              style={{
                width: 34,
                height: 34,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                border: "none",
                borderRadius: 8,
                background: theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                color: chrome.controlFg,
              }}
            >
              <ArrowLeft size={18} />
            </button>
          </div>
        )}
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
            {highlights.length}
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
                    : panelTab === "highlights"
                      ? `Highlights (${standaloneHighlights.length})`
                      : "Threads"}
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
                    { key: "threads", label: "Threads" },
                    { key: "highlights", label: `Highlights (${standaloneHighlights.length})` },
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
              {panelTab === "threads" && (
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: `1px solid ${chrome.panelBorder}`,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {activeThreadId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveThreadId(null)}
                        aria-label="Back to threads"
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
                        ← Back
                      </button>
                      <span
                        style={{
                          flex: 1,
                          fontWeight: 600,
                          fontSize: 13,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={threads.find((t) => t.id === activeThreadId)?.title ?? "New thread"}
                      >
                        {threads.find((t) => t.id === activeThreadId)?.title ?? "New thread"}
                      </span>
                      <button
                        type="button"
                        onClick={() => activeThreadId && void handleArchiveThread(activeThreadId)}
                        disabled={!!archivingThreadId}
                        aria-label={archivingThreadId ? "Archiving…" : "Archive thread"}
                        style={{
                          border: `1px solid ${chrome.controlBorder}`,
                          borderRadius: 6,
                          padding: "4px 8px",
                          background: chrome.controlBg,
                          color: chrome.controlFg,
                          cursor: archivingThreadId ? "wait" : "pointer",
                          fontSize: 12,
                          opacity: archivingThreadId ? 0.8 : 1,
                        }}
                      >
                        {archivingThreadId === activeThreadId ? "Archiving…" : "Archive"}
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>Threads</span>
                      <button
                        type="button"
                        onClick={createNewThread}
                        style={{
                          border: `1px solid ${chrome.controlBorder}`,
                          borderRadius: 6,
                          padding: "4px 10px",
                          background: chrome.controlBg,
                          color: chrome.controlFg,
                          cursor: "pointer",
                          fontSize: 12,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <NotepadText size={14} /> New thread
                      </button>
                    </>
                  )}
                </div>
              )}
              <div style={{ flex: 1, minHeight: 0, padding: 10, overflow: "auto", fontSize: 13, lineHeight: 1.45, display: "flex", flexDirection: "column" }}>
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
                            onClick={() => {
                              if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                              setJumpToCfi(bookmark.cfi);
                            }}
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
                ) : panelTab === "threads" && activeThreadId ? (
                  <>
                    <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 12, color: chrome.muted }}>Messages</div>
                    {activeThreadMessages.length === 0 ? (
                      <p style={{ margin: 0, color: chrome.muted, fontSize: 12 }}>
                        {pendingMessageExcerpt ? "Type your question below — the passage will be attached to your message." : "No messages yet. Type below to start the conversation, or select text and use Add to thread to attach a passage."}
                      </p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {activeThreadMessages.map((m) => {
                          const isUser = m.role === "user";
                          const excerptColorKey = (m.excerptColor === "blue" || m.excerptColor === "green" || m.excerptColor === "pink" ? m.excerptColor : "yellow") as keyof typeof HIGHLIGHT_COLOR_HEX;
                          const excerptHex = m.excerptText ? HIGHLIGHT_COLOR_HEX[excerptColorKey] ?? HIGHLIGHT_COLOR_HEX.yellow : null;
                          const excerptPreview =
                            m.excerptText &&
                            (() => {
                              const lines = m.excerptText!.split(/\n/).filter(Boolean);
                              const three = lines.slice(0, 3).join(" ");
                              return three.length > 180 ? three.slice(0, 180).trim() + "…" : three;
                            })();
                          const excerptExpanded = excerptExpandedIds.has(m.id);
                          const excerptDisplayText = m.excerptText && (excerptExpanded ? m.excerptText : excerptPreview);
                          return (
                            <div
                              key={m.id}
                              style={{
                                alignSelf: isUser ? "flex-end" : "flex-start",
                                maxWidth: "95%",
                                padding: "6px 8px",
                                borderRadius: 8,
                                background: isUser ? "rgba(31,111,235,0.12)" : (theme === "dark" ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.04)"),
                              }}
                            >
                              <div style={{ fontSize: 11, color: chrome.muted, marginBottom: 2 }}>{isUser ? "You" : "Claude"}</div>
                              {isUser && excerptDisplayText && excerptHex && (
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={() =>
                                    setExcerptExpandedIds((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(m.id)) next.delete(m.id);
                                      else next.add(m.id);
                                      return next;
                                    })
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      setExcerptExpandedIds((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(m.id)) next.delete(m.id);
                                        else next.add(m.id);
                                        return next;
                                      });
                                    }
                                  }}
                                  style={{
                                    marginBottom: 8,
                                    padding: "8px 10px",
                                    borderRadius: 6,
                                    background: theme === "dark" ? `rgba(0,0,0,0.25)` : `rgba(0,0,0,0.06)`,
                                    borderLeft: `3px solid ${excerptHex}`,
                                    boxShadow: "inset 0 1px 2px rgba(0,0,0,0.06)",
                                    fontSize: 12,
                                    lineHeight: 1.4,
                                    color: theme === "dark" ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.85)",
                                    cursor: "pointer",
                                    position: "relative",
                                    paddingRight: 32,
                                  }}
                                >
                                  <div style={{ fontStyle: "italic", whiteSpace: "pre-wrap" }}>"{excerptDisplayText}"</div>
                                  {(m.excerptChapter || m.excerptPage) && (
                                    <div style={{ fontSize: 11, color: chrome.muted, marginTop: 4 }}>
                                      {[m.excerptChapter, m.excerptPage].filter(Boolean).join(" · ")}
                                    </div>
                                  )}
                                  <div style={{ fontSize: 10, color: chrome.muted, marginTop: 4 }}>
                                    {excerptExpanded ? "Click to collapse" : "Click to expand"}
                                  </div>
                                  {m.excerptCfi && (
                                    <button
                                      type="button"
                                      title="Go to excerpt"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                        setJumpToCfi(m.excerptCfi!);
                                      }}
                                      onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
                                      style={{
                                        position: "absolute",
                                        bottom: 8,
                                        right: 8,
                                        padding: 4,
                                        border: "none",
                                        background: "transparent",
                                        color: chrome.muted,
                                        cursor: "pointer",
                                        borderRadius: 4,
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                      }}
                                      aria-label="Go to excerpt"
                                    >
                                      <ArrowRight size={14} />
                                    </button>
                                  )}
                                </div>
                              )}
                              <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : panelTab === "threads" && !activeThreadId ? (
                  <div style={{ marginBottom: 12 }}>
                    {threads.length === 0 ? (
                      <p style={{ margin: 0, color: chrome.muted, fontSize: 12 }}>No threads yet. Create one or select text and use Add to thread.</p>
                    ) : (
                      threads.map((thread) => (
                        <div
                          key={thread.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setActiveThreadId(thread.id)}
                          onKeyDown={(e) => e.key === "Enter" && setActiveThreadId(thread.id)}
                          style={{
                            marginBottom: 8,
                            padding: "8px 10px",
                            border: `1px solid ${chrome.panelBorder}`,
                            borderRadius: 8,
                            background: chrome.cardBg,
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{thread.title ?? "New thread"}</div>
                          <div style={{ fontSize: 11, color: chrome.muted, marginTop: 2 }}>
                            {new Date(thread.updatedAt).toLocaleDateString()}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ) : panelTab === "highlights" ? (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: chrome.muted }}>Highlights</div>
                    {standaloneHighlights.length === 0 ? (
                      <p style={{ margin: 0, color: chrome.muted, fontSize: 12 }}>No standalone highlights. Select text in the book and highlight it, or add a passage to a thread with Add to thread.</p>
                    ) : (
                      standaloneHighlights.map((h) => {
                        const colorHex = HIGHLIGHT_COLOR_HEX[h.color === "blue" || h.color === "green" || h.color === "pink" ? h.color : "yellow"];
                        return (
                          <div
                            key={h.id}
                            style={{
                              marginBottom: 8,
                              padding: "6px 8px",
                              borderLeft: `3px solid ${colorHex}`,
                              background: theme === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                              borderRadius: 4,
                              fontSize: 12,
                            }}
                          >
                            {h.selectedText.slice(0, 80)}{h.selectedText.length > 80 ? "…" : ""}
                            <button
                              type="button"
                              onClick={() => {
                                if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                setJumpToCfi(h.cfi);
                              }}
                              style={{ marginLeft: 8, fontSize: 11, padding: "2px 6px" }}
                            >
                              Go to
                            </button>
                          </div>
                        );
                      })
                    )}
                  </>
                ) : null}
              </div>
              {panelTab === "threads" && activeThreadId && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderTop: `1px solid ${chrome.panelBorder}`,
                    background: chrome.panelBg,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {pendingMessageExcerpt && (
                    <div
                      style={{
                        padding: "8px 10px",
                        borderRadius: 6,
                        background: theme === "dark" ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.06)",
                        borderLeft: "3px solid #e0d26c",
                        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.06)",
                        fontSize: 12,
                        lineHeight: 1.4,
                        color: theme === "dark" ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.85)",
                      }}
                    >
                      <div style={{ fontSize: 10, color: chrome.muted, marginBottom: 4 }}>Attached to next message</div>
                      <div style={{ fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                        "{pendingMessageExcerpt.text.length > 200 ? pendingMessageExcerpt.text.slice(0, 200).trim() + "…" : pendingMessageExcerpt.text}"
                      </div>
                      {(pendingMessageExcerpt.chapter || pendingMessageExcerpt.page) && (
                        <div style={{ fontSize: 11, color: chrome.muted, marginTop: 4 }}>
                          {[pendingMessageExcerpt.chapter, pendingMessageExcerpt.page].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      ref={threadChatInputRef}
                      type="text"
                      value={threadChatInput}
                      onChange={(e) => setThreadChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleThreadChatSend();
                        }
                      }}
                      placeholder="Ask about this thread or your highlights..."
                      disabled={threadChatAsking}
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: `1px solid ${chrome.controlBorder}`,
                        background: chrome.controlBg,
                        color: chrome.controlFg,
                        fontSize: 13,
                        outline: "none",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleThreadChatSend()}
                      disabled={threadChatAsking}
                      style={{
                        borderRadius: 8,
                        border: `1px solid ${chrome.controlBorder}`,
                        background: threadChatAsking ? chrome.muted : "#1f6feb",
                        color: "#fff",
                        padding: "10px 14px",
                        fontSize: 13,
                        cursor: threadChatAsking ? "wait" : "pointer",
                      }}
                    >
                      {threadChatAsking ? "…" : "Send"}
                    </button>
                  </div>
                  {threadChatError && (
                    <div style={{ fontSize: 12, color: "#b42318" }}>{threadChatError}</div>
                  )}
                </div>
              )}
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
                            if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
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
        {archiveToast && (
          <div
            aria-live="polite"
            style={{
              position: "absolute",
              left: "50%",
              bottom: 44,
              transform: "translateX(-50%)",
              zIndex: 121,
              padding: "8px 14px",
              borderRadius: 8,
              border: `1px solid ${chrome.panelBorder}`,
              background: chrome.panelBg,
              color: chrome.appFg,
              fontSize: 13,
              fontWeight: 500,
              boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
              pointerEvents: "none",
            }}
          >
            {archiveToast}
          </div>
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
      {openingBookId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9998,
            background: "rgba(255,255,255,0.92)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
          }}
          aria-live="polite"
          aria-busy="true"
        >
          <div
            style={{
              width: 40,
              height: 40,
              border: "3px solid rgba(0,0,0,0.12)",
              borderTopColor: "#1f6feb",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
          <p style={{ margin: 0, fontSize: 15, color: "#333" }}>Opening book…</p>
          <p style={{ margin: 0, fontSize: 12, color: "#666" }}>Large files may take a minute</p>
        </div>
      )}
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
