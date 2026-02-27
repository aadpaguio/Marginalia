import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
import { DocumentLoader } from "@/libs/document";
import type { BookDoc, TOCItem } from "@/libs/document";
import type { CitationPayload, Highlight, Thread, ThreadMessage } from "@/types/book";
import type { ReaderTheme } from "@/app/reader/utils/readerStyles";
import FoliateViewer from "@/app/reader/components/FoliateViewer";
import Library from "@/components/Library";
import {
  dbArchiveThread,
  dbDeleteThread,
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
  dbClearAllScanData,
  dbGetSectionSummaries,
  dbSetBookScanStatus,
  memoryEnsureDirs,
  memoryListBooks,
  memoryReadBook,
  memoryReadReader,
  memoryWriteBook,
  memoryWriteReader,
  type StoredBookmark,
  type StoredBook,
  type SectionSummary,
} from "@/services/db";
import { runSmartScan } from "@/services/smartScan";
import {
  compactThreadToJournal,
  extractReaderProfile,
  formatReaderMd,
  parseReaderMd,
} from "@/services/compaction";
import { askClaudeThread, generateThreadTitle } from "@/services/claude";
import { ArrowLeft, ArrowRight, ArrowUp, BookMarked, LogOut, MoreVertical, NotepadText, PanelLeft, PanelLeftClose, ScanText, Settings, SlidersHorizontal, Sparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "@/components/ThreadsPanel/ThreadsPanel.css";
import readerChromeStyles from "@/app/reader/ReaderChrome.module.css";
import tocPanelStyles from "@/app/reader/TocPanel.module.css";
import appStyles from "@/App.module.css";

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

/** Extract author from foliate-js metadata (author can be array of { name: string | Record<lang,string> }). */
function metadataAuthor(meta: { author?: unknown } | null | undefined, fallback: string): string {
  const a = meta?.author;
  if (typeof a === "string") return a.trim() || fallback;
  if (Array.isArray(a) && a.length > 0) {
    const parts = a.map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object" && "name" in entry) {
        const name = (entry as { name?: unknown }).name;
        if (typeof name === "string") return name.trim();
        if (name && typeof name === "object" && !Array.isArray(name)) {
          const first = Object.values(name).find((v): v is string => typeof v === "string");
          return first?.trim() ?? "";
        }
      }
      return "";
    });
    const joined = parts.filter(Boolean).join(", ");
    return joined || fallback;
  }
  return fallback;
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

type CitationSegment = { text: string; citation?: CitationPayload };

/** Parse citation payload with small repairs for common LLM formatting glitches (e.g. one extra trailing "}"). */
function parseCitationPayloadLenient(raw: string): CitationPayload | null {
  const attempts: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return null;
  attempts.push(trimmed);

  // Common model glitch: one or more extra trailing "}" before "-->"
  let repaired = trimmed;
  let openCount = (repaired.match(/\{/g) ?? []).length;
  let closeCount = (repaired.match(/\}/g) ?? []).length;
  while (closeCount > openCount && repaired.endsWith("}")) {
    repaired = repaired.slice(0, -1).trimEnd();
    attempts.push(repaired);
    openCount = (repaired.match(/\{/g) ?? []).length;
    closeCount = (repaired.match(/\}/g) ?? []).length;
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as CitationPayload;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try next repair
    }
  }
  return null;
}

/** Hide a trailing unfinished HTML comment while the assistant text is still streaming. */
function stripTrailingIncompleteHtmlComment(text: string): string {
  const lastOpen = text.lastIndexOf("<!--");
  const lastClose = text.lastIndexOf("-->");
  return lastOpen > lastClose ? text.slice(0, lastOpen) : text;
}

/** Extract one quoted passage at the start of a chunk (if present), preserving the remaining prose. */
function extractLeadingQuotedPassage(chunk: string): { quote: string | null; remainder: string } {
  const leadingWhitespace = (chunk.match(/^\s*/) ?? [""])[0];
  const start = chunk.slice(leadingWhitespace.length);
  if (!start) return { quote: null, remainder: chunk };
  const open = start[0];
  const close =
    open === '"' ? '"' :
    open === "'" ? "'" :
    open === "\u201c" ? "\u201d" :
    open === "\u2018" ? "\u2019" :
    null;
  if (!close) return { quote: null, remainder: chunk };
  const closeIdx = start.indexOf(close, 1);
  if (closeIdx < 0) return { quote: null, remainder: chunk };
  const rawQuoted = start.slice(0, closeIdx + 1).trim();
  const quote =
    rawQuoted.length >= 2 && rawQuoted[0] === open && rawQuoted[rawQuoted.length - 1] === close
      ? rawQuoted.slice(1, -1).trim()
      : rawQuoted;
  const remainder = `${leadingWhitespace}${start.slice(closeIdx + 1)}`;
  return { quote, remainder };
}

/** Split message text at inline <!--cite:{...}--> markers into renderable segments.
 * Citation comment precedes the quote: consume the quoted passage into a clickable citation card. */
function parseCitationSegments(text: string): CitationSegment[] {
  const safeText = stripTrailingIncompleteHtmlComment(text);
  const citeRegex = /<!--cite:([\s\S]*?)-->/g;
  const matches = [...safeText.matchAll(citeRegex)];
  if (matches.length > 0) {
    const segments: CitationSegment[] = [];
    let cursor = 0;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const markerStart = match.index ?? 0;
      const markerEnd = markerStart + match[0].length;
      const nextMarkerStart =
        i < matches.length - 1 ? (matches[i + 1].index ?? safeText.length) : safeText.length;
      const textBefore = safeText.slice(cursor, markerStart);
      const chunkAfterMarker = safeText.slice(markerEnd, nextMarkerStart);
      if (textBefore) segments.push({ text: textBefore });
      const parsedCitation = parseCitationPayloadLenient(match[1]);
      let citation: CitationPayload | undefined;
      if (parsedCitation) {
        citation = parsedCitation;
        const { quote, remainder } = extractLeadingQuotedPassage(chunkAfterMarker);
        if (quote && !citation.quote) citation = { ...citation, quote };
        if (citation) segments.push({ text: "", citation });
        if (remainder) segments.push({ text: remainder });
      }
      if (!citation && chunkAfterMarker) {
        segments.push({ text: chunkAfterMarker });
      }
      cursor = nextMarkerStart;
    }
    return segments;
  }

  // Legacy end-block format: <!--citations:{...}--> at the end
  const endMatch = safeText.match(/<!--\s*citations:\s*([\s\S]*?)\s*-->/);
  if (endMatch) {
    let citations: CitationPayload[] = [];
    try {
      const parsed = JSON.parse(endMatch[1]) as { items?: CitationPayload[]; citations?: CitationPayload[] };
      citations = parsed.items ?? parsed.citations ?? [];
    } catch { /* ignore */ }
    const cleanText = safeText.replace(endMatch[0], "").trim();
    // Return as a single text segment followed by individual citation-only segments
    return [
      { text: cleanText },
      ...citations.map((c) => ({ text: "", citation: c })),
    ];
  }

  return [{ text: safeText }];
}

type CitationJumpStatus = "idle" | "resolving" | "error";

const CitationJumpButton: FC<{
  citation: CitationPayload;
  onResolve: (citation: CitationPayload) => Promise<string | null>;
}> = ({ citation, onResolve }) => {
  const [status, setStatus] = useState<CitationJumpStatus>("idle");

  const handleClick = async () => {
    if (status === "resolving") return;
    setStatus("resolving");
    try {
      const cfi = await onResolve(citation);
      setStatus(cfi ? "idle" : "error");
      if (!cfi) setTimeout(() => setStatus("idle"), 2500);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2500);
    }
  };

  return (
    <button
      type="button"
      className={`thread-citation-card thread-citation-card--${status}`}
      onClick={handleClick}
      disabled={status === "resolving"}
    >
      <span className="thread-citation-quote">"{(() => { const q = citation.quote ?? "(passage)"; return q.length > 120 ? q.slice(0, 120).trim() + "…" : q; })()}"</span>
      <span className="thread-citation-jump">
        {status === "resolving" ? (
          <>
            <span className="thread-citation-spinner" />
            Locating…
          </>
        ) : status === "error" ? (
          <>
            <ArrowRight size={11} />
            Passage not found
          </>
        ) : (
          <>
            <ArrowRight size={11} />
            Jump to passage
          </>
        )}
      </span>
    </button>
  );
};

function App() {
  type PanelTab = "threads" | "highlights" | "annotations";
  type NotesFilter = "all" | "highlights" | "ai";
  type HighlightColorFilter = "all" | "yellow" | "blue" | "green" | "pink";
  const HIGHLIGHT_COLOR_HEX: Record<Exclude<HighlightColorFilter, "all">, string> = {
    yellow: "#e0d26c",
    blue: "#1f6feb",
    green: "#22a06b",
    pink: "#d94692",
  };
  const THREAD_QUICK_PROMPTS = ["Explain this", "Historical context", "Literary devices", "Define terms"];
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
  const [isNotesClosing, setIsNotesClosing] = useState(false);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
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
  /** When the model is running a tool, show this message in chat; null when thinking or done. */
  const [pendingToolMessage, setPendingToolMessage] = useState<string | null>(null);
  const TOOL_CHAT_LABELS: Record<string, string> = {
    get_context: "Reading nearby text…",
    get_section_summary: "Fetching section summary…",
    get_section_text: "Loading section text…",
    suggest_smart_scan: "Suggesting Smart Scan…",
  };
  const threadChatInputRef = useRef<HTMLInputElement | null>(null);
  const threadChatMessagesScrollRef = useRef<HTMLDivElement | null>(null);
  /** User message shown immediately on send; cleared when reply is persisted. */
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  /** Assistant reply text revealed sequentially; cleared when done. */
  const [pendingAssistantContent, setPendingAssistantContent] = useState("");
  const revealIntervalRef = useRef<number | null>(null);
  const [archivingThreadId, setArchivingThreadId] = useState<string | null>(null);
  const [archiveToast, setArchiveToast] = useState<string | null>(null);
  const archiveToastTimeoutRef = useRef<number | null>(null);
  const [threadMenuOpenId, setThreadMenuOpenId] = useState<string | null>(null);
  const threadMenuRef = useRef<HTMLDivElement | null>(null);
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
  const [scanStatus, setScanStatus] = useState<"none" | "in_progress" | "done">("none");
  const [sectionSummaries, setSectionSummaries] = useState<SectionSummary[]>([]);
  const [bookSummary, setBookSummary] = useState<string | null>(null);
  const [bookStructureType, setBookStructureType] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  /** When rate limited, seconds left until next retry (0 = retrying now). null = not waiting. */
  const [scanRetryInSeconds, setScanRetryInSeconds] = useState<number | null>(null);
  const [showSmartScanBanner, setShowSmartScanBanner] = useState(false);
  /** When true, open the next book and immediately trigger a Smart Scan. */
  const pendingScanAfterOpenRef = useRef(false);
  const getSectionTextRef = useRef<((tocHref?: string) => string) | null>(null);
  const getContextAroundCfiRef = useRef<
    ((cfi: string, charRadius: number) => string) | null
  >(null);
  const resolveCitationRef = useRef<
    ((citation: CitationPayload) => Promise<string | null>) | null
  >(null);
  /** Session-only working context: last 1–2 get_context results for follow-up continuity. Evicted on new fetch; not persisted. */
  const workingContextRef = useRef<string[]>([]);
  /** Fetches full text of a section by spine_href for get_section_text tool (e.g. to quote from "On origins"). Resolves "spine-N" by index when EPUB has no href. */
  const getSectionTextByHref = useCallback(
    async (spineHref: string): Promise<string> => {
      if (!bookDoc?.sections) return "";
      const hrefNorm = spineHref.split("#")[0].trim();
      const spineItems = bookDoc.sections.filter((s) => s.linear !== "no");
      let section: (typeof spineItems)[0] | undefined;
      const spineIndexMatch = hrefNorm.match(/^spine-(\d+)$/);
      if (spineIndexMatch) {
        const index = parseInt(spineIndexMatch[1], 10);
        section = spineItems[index];
      } else {
        section = bookDoc.sections.find((s) => {
          const sBase = (s.href ?? s.id ?? "").split("#")[0].trim();
          return sBase === hrefNorm || sBase.endsWith(hrefNorm) || hrefNorm.endsWith(sBase);
        });
      }
      if (!section) return "";
      try {
        const doc = await section.createDocument();
        return doc.body?.innerText?.trim() ?? "";
      } catch {
        return "";
      }
    },
    [bookDoc]
  );

  /** Normalize string for fuzzy match (smart quotes, collapsed whitespace). */
  const normalizeForQuoteMatch = useCallback((s: string) => {
    return s
      .replace(/\u201c|\u201d/g, '"')
      .replace(/\u2018|\u2019/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }, []);

  /** Strip one layer of surrounding quote chars so "passage" matches passage in the book. */
  const stripWrappingQuotes = useCallback((s: string): string => {
    const t = s.trim();
    if (t.length < 2) return t;
    if ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))
      return t.slice(1, -1).trim();
    if (t[0] === "\u201c" && t[t.length - 1] === "\u201d") return t.slice(1, -1).trim();
    if (t[0] === "\u2018" && t[t.length - 1] === "\u2019") return t.slice(1, -1).trim();
    return t;
  }, []);

  /** Find which section contains the citation quote (by fetching section text via createDocument). Returns index in bookDoc.sections for view.goTo(index). */
  const getSectionContainingQuote = useCallback(
    async (citation: CitationPayload): Promise<{ spineIndex: number } | null> => {
      let quote = citation.quote?.trim();
      if (quote && quote.length > 400) quote = citation.anchorBefore ?? quote;
      if (!quote) quote = citation.anchorBefore ?? "";
      if (!quote || !bookDoc?.sections) return null;
      quote = stripWrappingQuotes(quote);

      const spineItems = bookDoc.sections.filter((s) => s.linear !== "no");
      const normQuote = normalizeForQuoteMatch(quote);

      for (let i = 0; i < spineItems.length; i++) {
        const section = spineItems[i];
        const href = (section.href ?? section.id)?.split("#")[0].trim() || `spine-${i}`;
        const text = await getSectionTextByHref(href);
        if (!text) continue;
        const normText = normalizeForQuoteMatch(text);
        if (normText.includes(normQuote) || text.includes(quote)) {
          const spineIndex = bookDoc.sections!.indexOf(section);
          if (spineIndex >= 0) return { spineIndex };
        }
      }
      return null;
    },
    [bookDoc, getSectionTextByHref, normalizeForQuoteMatch, stripWrappingQuotes]
  );
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
    setScanStatus("none");
    setSectionSummaries([]);
    setBookSummary(null);
    setBookStructureType(null);
    setScanProgress(null);
    setShowSmartScanBanner(false);

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
      const normalizedAuthor = metadataAuthor(book.metadata, "Unknown");

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
      workingContextRef.current = [];
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

      // Load Smart Scan data
      const bookData = await dbGetBook(bookId);
      let storedScanStatus = (bookData?.smartScanStatus ?? "none") as "none" | "in_progress" | "done";
      // Stale "in_progress" (e.g. app crashed or was closed during scan) — reset so the button is clickable again
      if (storedScanStatus === "in_progress") {
        await dbSetBookScanStatus(bookId, "none");
        storedScanStatus = "none";
      }
      const storedBookSummary = bookData?.bookSummary ?? null;
      const storedBookStructureType = bookData?.bookStructureType ?? null;
      setScanStatus(storedScanStatus);
      setBookSummary(storedBookSummary);
      setBookStructureType(storedBookStructureType);
      const storedSummaries = await dbGetSectionSummaries(bookId);
      setSectionSummaries([...storedSummaries].sort((a, b) => a.spineIndex - b.spineIndex));

      setBookDoc(book);
      console.log("[OpenBook] Done");
      await refreshLibrary();

      // Auto-trigger scan if requested from library card
      if (pendingScanAfterOpenRef.current) {
        pendingScanAfterOpenRef.current = false;
        const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
        if (apiKey) {
          void runSmartScan({
            bookId,
            bookDoc: book,
            apiKey,
            onProgress: (done, total) => setScanProgress({ done, total }),
            onScanStatusChange: (status) => {
              setScanStatus(status);
              void refreshLibrary();
            },
            onSectionSummaryAdded: (summary) =>
              setSectionSummaries((prev) => {
                const idx = prev.findIndex((s) => s.id === summary.id);
                const next = idx >= 0 ? [...prev.slice(0, idx), summary, ...prev.slice(idx + 1)] : [...prev, summary];
                return next.sort((a, b) => a.spineIndex - b.spineIndex);
              }),
            onBookSummarySet: setBookSummary,
            onBookStructureTypeSet: setBookStructureType,
          });
        }
      }
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

  /* Auto-scroll thread messages to bottom when new content appears. */
  useEffect(() => {
    const el = threadChatMessagesScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeThreadMessages, pendingUserMessage, pendingAssistantContent]);

  useEffect(() => {
    return () => {
      if (revealIntervalRef.current != null) {
        window.clearInterval(revealIntervalRef.current);
        revealIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (threadMenuOpenId == null) return;
    const onPointer = (e: MouseEvent) => {
      if (threadMenuRef.current && e.target instanceof Node && !threadMenuRef.current.contains(e.target)) {
        setThreadMenuOpenId(null);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [threadMenuOpenId]);

  useEffect(() => {
    setPendingUserMessage(null);
    setPendingAssistantContent("");
    if (revealIntervalRef.current != null) {
      window.clearInterval(revealIntervalRef.current);
      revealIntervalRef.current = null;
    }
    if (!activeThreadId || !currentBookId) {
      setActiveThreadMessages([]);
      setActiveThreadHighlights([]);
      setThreadChatError(null);
      return;
    }
    setThreadChatError(null);
    workingContextRef.current = [];
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
      // Compaction only runs when archiving a thread; no auto-compaction on close
      await invoke("allow_window_close");
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, []);

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
        // Compaction only runs when archiving; no auto-compaction on message save
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
          bookTitle: toDisplayString(bookDoc.metadata?.title, "Book"),
          author: metadataAuthor(bookDoc.metadata, "Unknown"),
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

  const handleDeleteThread = async (threadId: string) => {
    setThreadMenuOpenId(null);
    try {
      await dbDeleteThread(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (activeThreadId === threadId) setActiveThreadId(null);
    } catch (e) {
      console.error("[Delete thread]", e);
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
    setPendingUserMessage(userMessage);
    setPendingAssistantContent("");
    setPendingToolMessage(null);
    if (revealIntervalRef.current != null) {
      window.clearInterval(revealIntervalRef.current);
      revealIntervalRef.current = null;
    }
    try {
      const [bookMemory, readerProfile] = await Promise.all([
        memoryReadBook(currentBookId),
        memoryReadReader(),
      ]);
      const result = await askClaudeThread(
        {
          threadId: activeThreadId,
          messages: activeThreadMessages,
          attachedHighlights: activeThreadHighlights.filter((h) => h.bookId === currentBookId),
          userMessage,
          bookTitle: toDisplayString(bookDoc.metadata?.title, "Book"),
          author: metadataAuthor(bookDoc.metadata, "Unknown"),
          bookId: currentBookId,
          bookMemory: bookMemory ?? undefined,
          readerProfile: readerProfile ?? undefined,
          workingContext: workingContextRef.current.join("\n\n---\n\n"),
          bookSummary: bookSummary ?? undefined,
          sectionSummaries: sectionSummaries.length > 0 ? sectionSummaries : undefined,
          scanStatus,
          bookStructureType: bookStructureType ?? undefined,
          currentCfi: currentTocHref ?? currentCfi ?? undefined,
          onSuggestSmartScan: () => setShowSmartScanBanner(true),
          getContextAroundCfi: getContextAroundCfiRef.current ?? (() => ""),
          getSectionTextByHref,
          onToolCall: (toolName) =>
            setPendingToolMessage(TOOL_CHAT_LABELS[toolName] ?? "Working…"),
          onContextFetched: (text: string) => {
            const arr = workingContextRef.current;
            arr.push(text);
            if (arr.length > 2) arr.shift();
          },
        },
        apiKey
      );
      const fullAnswer = result.answer ?? "";
      const excerpt = pendingMessageExcerpt
        ? {
            text: pendingMessageExcerpt.text,
            cfi: pendingMessageExcerpt.cfi,
            chapter: pendingMessageExcerpt.chapter,
            color: pendingMessageExcerpt.color,
            page: pendingMessageExcerpt.page ?? currentPageLabel ?? null,
          }
        : undefined;
      setPendingMessageExcerpt(null);

      /* Reveal assistant reply sequentially, then persist and clear pending. */
      const REVEAL_CHUNK = 3;
      const REVEAL_MS = 16;
      let index = 0;
      revealIntervalRef.current = window.setInterval(() => {
        index += REVEAL_CHUNK;
        const slice = fullAnswer.slice(0, index);
        setPendingAssistantContent(slice);
        if (slice.length >= fullAnswer.length) {
          if (revealIntervalRef.current != null) {
            window.clearInterval(revealIntervalRef.current);
            revealIntervalRef.current = null;
          }
          handleMessagePair(userMessage, fullAnswer, excerpt);
          setPendingUserMessage(null);
          setPendingAssistantContent("");
          setPendingToolMessage(null);
          setThreadChatAsking(false);
          threadChatInputRef.current?.focus();
        }
      }, REVEAL_MS);
    } catch (e) {
      setThreadChatError(e instanceof Error ? e.message : String(e));
      setPendingUserMessage(null);
      setPendingAssistantContent("");
      setPendingToolMessage(null);
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

  const handleRunSmartScan = async () => {
    if (!currentBookId || !bookDoc || scanStatus === "in_progress") return;
    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) {
      alert("Add VITE_ANTHROPIC_API_KEY to .env and restart.");
      return;
    }
    const isRescan = scanStatus === "done";
    const confirmed = window.confirm(
      isRescan
        ? "Replace existing scan with a fresh one?"
        : "Smart Scan reads every section and generates summaries (~30s, one-time). If the API is rate limited, it will pause; run again to resume from where it left off. Run it?"
    );
    if (!confirmed) return;
    if (isRescan) {
      setSectionSummaries([]);
      setBookSummary(null);
    }
    setScanProgress(null);
    setScanRetryInSeconds(null);
    void runSmartScan({
      bookId: currentBookId,
      bookDoc,
      apiKey,
      onProgress: (done, total) => {
        setScanProgress({ done, total });
        setScanRetryInSeconds(null);
      },
      onScanStatusChange: (status) => {
        setScanStatus(status);
        setScanRetryInSeconds(null);
        void refreshLibrary();
      },
      onRateLimitWait: (secondsLeft) => {
        setScanRetryInSeconds(secondsLeft);
        if (secondsLeft === 0) setTimeout(() => setScanRetryInSeconds(null), 800);
      },
      onSectionSummaryAdded: (summary) =>
        setSectionSummaries((prev) => {
          const idx = prev.findIndex((s) => s.id === summary.id);
          const next = idx >= 0 ? [...prev.slice(0, idx), summary, ...prev.slice(idx + 1)] : [...prev, summary];
          return next.sort((a, b) => a.spineIndex - b.spineIndex);
        }),
      onBookSummarySet: setBookSummary,
      onBookStructureTypeSet: setBookStructureType,
    });
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
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            height: "100%",
            width: "100%",
            overflow: "hidden",
          }}
        >
          {/* TOC panel — §7: rail + expandable content */}
          <div
            className={`${tocPanelStyles.panel} ${!isTocOpen ? tocPanelStyles.panelCollapsed : ""}`}
            style={{ height: "100%" }}
          >
            <div className={tocPanelStyles.rail}>
              <button
                type="button"
                className={tocPanelStyles.tocToggle}
                onClick={() => setIsTocOpen((prev) => !prev)}
                aria-label={isTocOpen ? "Hide table of contents" : "Show table of contents"}
                title={isTocOpen ? "Hide table of contents" : "Show table of contents"}
              >
                {isTocOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
              </button>
              <div className={tocPanelStyles.actionStrip}>
                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    className={tocPanelStyles.actionButton}
                    onClick={() => setIsThemeMenuOpen((o) => !o)}
                    title="Display options"
                    aria-label="Display options (theme)"
                    aria-expanded={isThemeMenuOpen}
                  >
                    <SlidersHorizontal size={18} />
                  </button>
                  {isThemeMenuOpen && (
                    <div className={tocPanelStyles.railThemeMenu}>
                      {(["light", "sepia", "dark"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            setTheme(t);
                            setIsThemeMenuOpen(false);
                          }}
                          title={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
                          aria-label={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
                          className={`${tocPanelStyles.railThemeButton} ${theme === t ? tocPanelStyles.railThemeButtonActive : ""}`}
                        >
                          {t.charAt(0).toUpperCase()}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={scanStatus === "done" ? tocPanelStyles.actionButtonActive : tocPanelStyles.actionButton}
                  onClick={() => void handleRunSmartScan()}
                  disabled={scanStatus === "in_progress"}
                  title={
                    scanStatus === "none"
                      ? "Run Smart Scan"
                      : scanStatus === "in_progress"
                        ? "Scanning…"
                        : "Smart Scan complete · Re-scan"
                  }
                  aria-label="Smart Scan"
                >
                  <ScanText size={18} />
                </button>
                <button
                  type="button"
                  className={tocPanelStyles.actionButton}
                  title="Settings"
                  aria-label="Settings"
                >
                  <Settings size={18} />
                </button>
                <button
                  type="button"
                  className={`${tocPanelStyles.actionButton} ${tocPanelStyles.railCloseButton}`}
                  onClick={() => {
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
                  title="Close"
                  aria-label="Close"
                >
                  <LogOut size={18} />
                </button>
              </div>
            </div>
            <div className={tocPanelStyles.content}>
              <div className={tocPanelStyles.sectionLabel}>CONTENTS</div>
              {tocEntries.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--ink-tertiary)", padding: "0 var(--space-3)" }}>No TOC available</div>
              ) : (
                tocEntries.map((item, idx) => {
                  const renderTocItem = (toc: TOCItem, depth: number) => {
                    const active =
                      (currentTocHref && toc.href === currentTocHref) ||
                      (currentTocLabel && toc.label === currentTocLabel);
                    const depthClass =
                      depth === 0 ? tocPanelStyles.tocDepth0 : depth === 1 ? tocPanelStyles.tocDepth1 : tocPanelStyles.tocDepth2;
                    return (
                      <div key={`${toc.href}-${depth}-${toc.id}`}>
                        <button
                          type="button"
                          className={`${tocPanelStyles.tocItem} ${depthClass} ${active ? tocPanelStyles.tocItemActive : ""}`}
                          onClick={() => {
                            if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                            setJumpToCfi(toc.href);
                            setIsTocOpen(false);
                          }}
                        >
                          {toc.label || `Section ${idx + 1}`}
                        </button>
                        {toc.subitems?.map((sub) => renderTocItem(sub, depth + 1))}
                      </div>
                    );
                  };
                  return renderTocItem(item, 0);
                })
              )}
            </div>
          </div>
          {/* Reading area */}
          <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
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
          onRegisterGetContextAroundCfi={(fn) => {
            getContextAroundCfiRef.current = fn;
          }}
          onRegisterResolveCitation={(fn: ((citation: CitationPayload) => Promise<string | null>) | null) => {
            resolveCitationRef.current = fn;
          }}
          getSectionContainingQuote={getSectionContainingQuote}
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
        {/* Smart Scan status strip: show in reading area when scanning (optional, or keep in rail) */}
        {scanStatus === "in_progress" && (
          <div
            style={{
              position: "absolute",
              top: 88,
              left: 8,
              zIndex: 130,
            }}
          >
            <div className={readerChromeStyles.scanStatusStrip}>
              <span className={readerChromeStyles.scanStatusLabel}>Smart Scan</span>
              {scanRetryInSeconds !== null ? (
                <span className={readerChromeStyles.scanRateLimitMessage}>
                  {scanRetryInSeconds > 0 ? (
                    <>Rate limited. <strong>Retrying in {scanRetryInSeconds}s…</strong></>
                  ) : (
                    <strong>Retrying…</strong>
                  )}
                </span>
              ) : scanProgress ? (
                <>
                  <span className={readerChromeStyles.scanProgressText}>
                    {scanProgress.done} / {scanProgress.total} sections
                  </span>
                  <div className={readerChromeStyles.scanProgressTrack}>
                    <div
                      className={readerChromeStyles.scanProgressFill}
                      style={{
                        width: `${scanProgress.total > 0 ? (100 * scanProgress.done) / scanProgress.total : 0}%`,
                      }}
                    />
                  </div>
                </>
              ) : (
                <span className={readerChromeStyles.scanProgressText}>Scanning…</span>
              )}
            </div>
          </div>
        )}
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
        {!isNotesOpen && !isNotesClosing && (
          <button
            type="button"
            className="notesPanelTab"
            onClick={() => setIsNotesOpen(true)}
            aria-label="Open notes panel"
          >
            <BookMarked size={14} className="notesPanelTabIcon" />
          </button>
        )}
        {(isNotesOpen || isNotesClosing) && (
          <>
            <button
              type="button"
              aria-label="Close notes panel"
              onClick={() => !isNotesClosing && setIsNotesClosing(true)}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 199,
                border: "none",
                background: "transparent",
                padding: 0,
                margin: 0,
              }}
            />
            <aside
              className={`notes-panel ${isNotesClosing ? "panelHidden" : "panelVisible"} ${panelTab === "threads" ? "notes-panel--threads" : ""}`}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                zIndex: 200,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
              onClick={(e) => e.stopPropagation()}
              onWheelCapture={(e) => e.stopPropagation()}
              onAnimationEnd={(e) => {
                if (e.animationName === "panelExitRight") {
                  setIsNotesOpen(false);
                  setIsNotesClosing(false);
                }
              }}
            >
              <div
                className="threads-panel-title-bar"
                style={{
                  padding: "var(--space-4) var(--space-5)",
                  fontSize: 15,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span>Notes</span>
                <button
                  type="button"
                  className="threads-close-btn"
                  onClick={() => !isNotesClosing && setIsNotesClosing(true)}
                  style={{
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-1) var(--space-2)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Close
                </button>
              </div>
              <div className="threads-tab-bar">
                {(
                  [
                    { key: "threads" as const, label: "Threads" },
                    { key: "highlights" as const, label: `Highlights (${standaloneHighlights.length})` },
                    { key: "annotations" as const, label: "Annotations" },
                  ] as const
                ).map((tab) => {
                  const active = panelTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      className={active ? "notes-tab notes-tab-active" : "notes-tab"}
                      onClick={() => setPanelTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              {panelTab === "threads" && (
                <div
                  className="thread-chat-header"
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
                        className="thread-header-back-btn"
                        onClick={() => setActiveThreadId(null)}
                        aria-label="Back to threads"
                      >
                        ← Back
                      </button>
                      <span
                        className="thread-chat-title"
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
                      <div ref={threadMenuRef} style={{ position: "relative" }}>
                        <button
                          type="button"
                          className="thread-header-menu-trigger"
                          onClick={() => setThreadMenuOpenId((id) => (id === activeThreadId ? null : activeThreadId))}
                          disabled={!!archivingThreadId}
                          aria-label="Thread options"
                          aria-expanded={threadMenuOpenId === activeThreadId}
                        >
                          <MoreVertical size={16} />
                        </button>
                        {threadMenuOpenId === activeThreadId && (
                          <div className="thread-header-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="thread-header-menu-item"
                              onClick={() => activeThreadId && void handleArchiveThread(activeThreadId)}
                              disabled={archivingThreadId === activeThreadId}
                            >
                              {archivingThreadId === activeThreadId ? "Archiving…" : "Archive"}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="thread-header-menu-item thread-header-menu-item-danger"
                              onClick={() => activeThreadId && void handleDeleteThread(activeThreadId)}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="thread-chat-title threads-section-label" style={{ flex: 1 }}>Threads</span>
                      <button
                        type="button"
                        className="threads-new-thread-btn"
                        onClick={createNewThread}
                      >
                        <NotepadText size={14} /> New thread
                      </button>
                    </>
                  )}
                </div>
              )}
              <div
                ref={panelTab === "threads" ? threadChatMessagesScrollRef : null}
                className={panelTab === "threads" ? "thread-chat-content" : undefined}
                style={{
                  flex: 1,
                  minHeight: 0,
                  padding: panelTab === "threads" ? "var(--space-3) var(--space-4)" : 10,
                  overflow: "auto",
                  fontSize: 13,
                  lineHeight: 1.45,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {panelTab === "annotations" ? (
                  <p style={{ margin: 0, color: "var(--ink-tertiary)", fontSize: 13, textAlign: "center" }}>
                    Coming soon
                  </p>
                ) : panelTab === "threads" && activeThreadId ? (
                  <>
                    <div className="thread-chat-messages-label" style={{ marginBottom: 8, fontWeight: 600, fontSize: 12, color: chrome.muted }}>Messages</div>
                    {(() => {
                      const displayMessages: ThreadMessage[] = [...activeThreadMessages];
                      if (pendingUserMessage != null) {
                        displayMessages.push({
                          id: "pending-user",
                          threadId: activeThreadId,
                          role: "user",
                          content: pendingUserMessage,
                          createdAt: Date.now(),
                        });
                        displayMessages.push({
                          id: "pending-assistant",
                          threadId: activeThreadId,
                          role: "assistant",
                          content: pendingAssistantContent,
                          createdAt: Date.now(),
                        });
                      }
                      return displayMessages.length === 0 ? (
                        <>
                          <p className="thread-chat-empty-hint" style={{ margin: 0, marginBottom: "var(--space-3)" }}>
                            {pendingMessageExcerpt ? "Type your question below — the passage will be attached to your message." : "No messages yet. Type below or pick a prompt, or select text and use Add to thread to attach a passage."}
                          </p>
                          <div className="thread-quick-prompts">
                            {THREAD_QUICK_PROMPTS.map((prompt) => (
                              <button
                                key={prompt}
                                type="button"
                                className="thread-chip"
                                onClick={() => {
                                  setThreadChatInput(prompt);
                                  threadChatInputRef.current?.focus();
                                }}
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
                        {displayMessages.map((m) => {
                          const isUser = m.role === "user";
                          const isPendingAssistant = m.id === "pending-assistant";
                          const showTypingDots = isPendingAssistant && m.content === "";
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
                              className={`thread-msg-row ${isUser ? "thread-msg-row--user" : "thread-msg-row--assistant"}`}
                              style={{ maxWidth: "95%" }}
                            >
                              <div className="thread-msg-sender">{isUser ? "You" : "Marginalia"}</div>
                              <div className="thread-msg-bubble">
                                {isUser && excerptDisplayText && excerptHex && (
                                  <div
                                    className="thread-excerpt-card"
                                    data-excerpt-color={m.excerptColor === "blue" || m.excerptColor === "green" || m.excerptColor === "pink" ? m.excerptColor : "yellow"}
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
                                  >
                                    <div className="thread-excerpt-label">Passage</div>
                                    <div style={{ fontStyle: "italic", whiteSpace: "pre-wrap" }}>"{excerptDisplayText}"</div>
                                    {(m.excerptChapter || m.excerptPage) && (
                                      <div className="thread-excerpt-meta">
                                        {[m.excerptChapter, m.excerptPage].filter(Boolean).join(" · ")}
                                      </div>
                                    )}
                                    <div className="thread-excerpt-expand-hint">
                                      {excerptExpanded ? "Click to collapse" : "Click to expand"}
                                    </div>
                                    {m.excerptCfi && (
                                      <button
                                        type="button"
                                        className="thread-excerpt-goto-btn"
                                        title="Go to excerpt"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                          setJumpToCfi(m.excerptCfi!);
                                        }}
                                        onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
                                        aria-label="Go to excerpt"
                                      >
                                        <ArrowRight size={14} />
                                      </button>
                                    )}
                                  </div>
                                )}
                                {isUser ? (
                                  <div className="thread-msg-text">{m.content}</div>
                                ) : showTypingDots ? (
                                  <div className="thread-context-fetch">
                                    <span className="thread-context-fetch__dot" /><span className="thread-context-fetch__dot" /><span className="thread-context-fetch__dot" />
                                    <span className="thread-context-fetch__label">
                                      {pendingToolMessage ?? "Thinking…"}
                                    </span>
                                  </div>
                                ) : isPendingAssistant ? (
                                  <div className="thread-msg-content">
                                    {parseCitationSegments(m.content).map((seg, segIdx) => (
                                      <div key={segIdx}>
                                        {seg.text && (
                                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
                                        )}
                                        {seg.citation && (
                                          <CitationJumpButton
                                            citation={seg.citation}
                                            onResolve={async (c) => {
                                              const cfi = await resolveCitationRef.current?.(c) ?? null;
                                              if (cfi) {
                                                if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                                setJumpToCfi(cfi);
                                              }
                                              return cfi;
                                            }}
                                          />
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="thread-msg-content">
                                    {parseCitationSegments(m.content).map((seg, segIdx) => (
                                      <div key={segIdx}>
                                        {seg.text && (
                                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
                                        )}
                                        {seg.citation && (
                                          <CitationJumpButton
                                            citation={seg.citation}
                                            onResolve={async (c) => {
                                              const cfi = await resolveCitationRef.current?.(c) ?? null;
                                              if (cfi) {
                                                if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                                setJumpToCfi(cfi);
                                              }
                                              return cfi;
                                            }}
                                          />
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                    })()}
                  </>
                ) : panelTab === "threads" && !activeThreadId ? (
                  <div style={{ marginBottom: 12 }}>
                    {threads.length === 0 ? (
                      <p className="thread-list-empty" style={{ margin: 0 }}>No threads yet. Create one or select text and use Add to thread.</p>
                    ) : (
                      threads.map((thread) => (
                        <div
                          key={thread.id}
                          className="thread-list-item"
                          style={{ marginBottom: "var(--space-2)" }}
                        >
                          <div
                            ref={threadMenuOpenId === thread.id ? threadMenuRef : null}
                            className="thread-list-item-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="thread-header-menu-trigger thread-list-item-menu-trigger"
                              aria-label="Thread options"
                              aria-expanded={threadMenuOpenId === thread.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setThreadMenuOpenId((id) => (id === thread.id ? null : thread.id));
                              }}
                            >
                              <MoreVertical size={16} />
                            </button>
                            {threadMenuOpenId === thread.id && (
                              <div className="thread-header-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="thread-header-menu-item"
                                  onClick={() => {
                                    setThreadMenuOpenId(null);
                                    void handleArchiveThread(thread.id);
                                  }}
                                  disabled={archivingThreadId === thread.id}
                                >
                                  {archivingThreadId === thread.id ? "Archiving…" : "Archive"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="thread-header-menu-item thread-header-menu-item-danger"
                                  onClick={() => void handleDeleteThread(thread.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                          <div
                            className="thread-list-item-main"
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              setPendingMessageExcerpt(null);
                              setActiveThreadId(thread.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setPendingMessageExcerpt(null);
                                setActiveThreadId(thread.id);
                              }
                            }}
                          >
                            <div className="thread-list-item-title">{thread.title ?? "Untitled"}</div>
                            <div className="thread-list-item-date">
                              {new Date(thread.updatedAt).toLocaleDateString()}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ) : panelTab === "highlights" ? (
                  (() => {
                    const highlightsByChapter = (() => {
                      const map = new Map<string, typeof standaloneHighlights>();
                      for (const h of standaloneHighlights) {
                        const ch = h.chapterLabel ?? "Other";
                        if (!map.has(ch)) map.set(ch, []);
                        map.get(ch)!.push(h);
                      }
                      return Array.from(map.entries());
                    })();
                    return standaloneHighlights.length === 0 ? (
                      <p style={{ margin: 0, color: "var(--ink-tertiary)", fontSize: 13, textAlign: "center" }}>
                        No highlights yet. Select text to start.
                      </p>
                    ) : (
                      <>
                        <div className="notes-highlights-tab-header">
                          <span className="threads-section-label">Highlights</span>
                          <span className="notes-highlights-tab-count">{standaloneHighlights.length}</span>
                        </div>
                        {highlightsByChapter.map(([chapterName, chapterHighlights]) => (
                          <div key={chapterName}>
                            <div className="notes-highlights-chapter-label">{chapterName}</div>
                            {chapterHighlights.map((h) => {
                              const swatch = (h.color === "blue" || h.color === "green" || h.color === "pink" ? h.color : "yellow") as "yellow" | "blue" | "green" | "pink";
                              return (
                                <div
                                  key={h.id}
                                  className="notes-highlight-row"
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => {
                                    if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                    setJumpToCfi(h.cfi);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      if (currentCfiRef.current) setBackCfi(currentCfiRef.current);
                                      setJumpToCfi(h.cfi);
                                    }
                                  }}
                                >
                                  <div className="notes-highlight-row-swatch" data-swatch={swatch} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div className="notes-highlight-row-quote">"{h.selectedText}"</div>
                                    <div className="notes-highlight-row-meta">
                                      {[chapterName, new Date(h.createdAt).toLocaleDateString()].filter(Boolean).join(" · ")}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </>
                    );
                  })()
                ) : null}
              </div>
              {panelTab === "threads" && activeThreadId && (
                <div
                  className="thread-chat-input-area"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  {pendingMessageExcerpt && (
                    <div className="thread-pending-excerpt">
                      <button
                        type="button"
                        className="thread-pending-excerpt-remove"
                        onClick={() => setPendingMessageExcerpt(null)}
                        aria-label="Remove attached passage"
                        title="Remove from next message"
                      >
                        <X size={14} />
                      </button>
                      <div style={{ fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                        "{pendingMessageExcerpt.text.length > 200 ? pendingMessageExcerpt.text.slice(0, 200).trim() + "…" : pendingMessageExcerpt.text}"
                      </div>
                      {(pendingMessageExcerpt.chapter || pendingMessageExcerpt.page) && (
                        <div className="thread-excerpt-meta">
                          {[pendingMessageExcerpt.chapter, pendingMessageExcerpt.page].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="thread-chat-input-row">
                    <input
                      ref={threadChatInputRef}
                      type="text"
                      className="thread-chat-input"
                      value={threadChatInput}
                      onChange={(e) => setThreadChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleThreadChatSend();
                        }
                      }}
                      placeholder="Ask about this passage…"
                      disabled={threadChatAsking}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="thread-chat-send-btn"
                      onClick={() => void handleThreadChatSend()}
                      disabled={threadChatAsking}
                      aria-label="Send"
                    >
                      {threadChatAsking ? "…" : <ArrowUp size={16} />}
                    </button>
                  </div>
                  {threadChatError && (
                    <div className="thread-chat-error">{threadChatError}</div>
                  )}
                </div>
              )}
            </aside>
          </>
        )}
        {showSmartScanBanner && (
          <div
            aria-live="polite"
            style={{
              position: "absolute",
              left: "50%",
              top: 50,
              transform: "translateX(-50%)",
              zIndex: 135,
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${chrome.panelBorder}`,
              background: chrome.panelBg,
              color: chrome.appFg,
              fontSize: 13,
              fontWeight: 500,
              boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              whiteSpace: "nowrap",
            }}
          >
            <Sparkles size={14} style={{ flexShrink: 0 }} />
            <span>Marginalia thinks a Smart Scan would improve answers. Start one from the toolbar above.</span>
            <button
              type="button"
              onClick={() => setShowSmartScanBanner(false)}
              aria-label="Dismiss"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: chrome.muted,
                padding: "2px 4px",
                fontSize: 13,
              }}
            >
              <X size={14} />
            </button>
          </div>
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
        onScanBook={(book) => {
          if (book.smartScanStatus === "in_progress") return;
          const isRescan = book.smartScanStatus === "done";
          const confirmed = window.confirm(
            isRescan
              ? "Replace existing scan with a fresh one?"
              : "Smart Scan reads every section and generates summaries (~30s, one-time). If rate limited, run again to resume. Run it?"
          );
          if (!confirmed) return;
          pendingScanAfterOpenRef.current = true;
          void openBookFromPath(book.filePath, book.id);
        }}
        onClearScanData={async () => {
          if (!window.confirm("Delete all Smart Scan data (section + book summaries) and reset scan status for every book? You can re-run Smart Scan on any book afterward.")) return;
          await dbClearAllScanData();
          await refreshLibrary();
        }}
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
