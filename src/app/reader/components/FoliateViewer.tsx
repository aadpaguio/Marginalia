import React, { useEffect, useRef, useState, useCallback } from "react";
import type { BookDoc } from "@/libs/document";
import type { FoliateView } from "@/types/view";
import { useFoliateEvents } from "../hooks/useFoliateEvents";
import { useMouseEvent, useTouchEvent } from "../hooks/useIframeEvents";
import {
  handleKeydown,
  handleKeyup,
  handleMousedown,
  handleMouseup,
  handleClick,
  handleWheel,
  handleTouchStart,
  handleTouchMove,
  handleTouchEnd,
} from "../utils/iframeEventHandlers";
import { getReaderStyles, type ReaderTheme } from "../utils/readerStyles";
import { useInstantAnnotation } from "../hooks/useInstantAnnotation";
import Annotator from "./annotator/Annotator";
import type { CitationPayload, Highlight } from "@/types/book";
import { Bookmark, ChevronDown, Plus, SlidersHorizontal } from "lucide-react";

/** Normalize for fuzzy match: smart quotes → straight, collapse whitespace. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
/** Strip one layer of surrounding quote characters so "passage" matches passage in the book. */
function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if (t.length < 2) return t;
  if ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))
    return t.slice(1, -1).trim();
  if (t[0] === "\u201c" && t[t.length - 1] === "\u201d") return t.slice(1, -1).trim();
  if (t[0] === "\u2018" && t[t.length - 1] === "\u2019") return t.slice(1, -1).trim();
  return t;
}

/**
 * Find quote in document and return a Range covering it, or null.
 * Uses text-node walk + optional normalized match so citations work when
 * Window.find() is unavailable (e.g. in iframes) or quote has smart quotes.
 * Strips surrounding quote characters so "passage" matches passage in the book.
 */
function findQuoteRangeInDocument(doc: Document, quote: string): Range | null {
  const body = doc.body;
  if (!body) return null;

  const textNodes: { node: Text; start: number }[] = [];
  let totalLength = 0;

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const len = text.length;
      if (len > 0) {
        textNodes.push({ node: text, start: totalLength });
        totalLength += len;
      }
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
      }
    }
  }
  walk(body);

  const fullText = textNodes
    .map((t) => t.node.textContent ?? "")
    .join("");
  if (fullText.length === 0) return null;

  const quoteTrim = stripWrappingQuotes(quote.trim());
  if (quoteTrim.length === 0) return null;

  let startIdx = fullText.indexOf(quoteTrim);
  let endIdx = startIdx + quoteTrim.length;

  if (startIdx === -1) {
    const normQuote = normalizeForMatch(quoteTrim);
    if (normQuote.length === 0) return null;
    const normChars: string[] = [];
    const normToOriginal: number[] = [];
    for (let i = 0; i < fullText.length; i++) {
      const c = fullText[i];
      const n =
        c === "\u201c" || c === "\u201d"
          ? '"'
          : c === "\u2018" || c === "\u2019"
            ? "'"
            : c;
      if (/\s/.test(n)) {
        if (normChars.length === 0 || normChars[normChars.length - 1] !== " ") {
          normChars.push(" ");
          normToOriginal.push(i);
        }
      } else {
        normChars.push(n);
        normToOriginal.push(i);
      }
    }
    const normFull = normChars.join("");
    const normIdx = normFull.indexOf(normQuote);

    if (normIdx !== -1) {
      startIdx = normToOriginal[normIdx];
      endIdx = normToOriginal[normIdx + normQuote.length - 1] + 1;
    } else {
      // Ellipsis-aware fallback: handles leading, trailing, and middle '...' / '…'.
      const ellipsisToken = /\.{3}|…/;
      if (!ellipsisToken.test(quoteTrim)) return null;

      // Strip leading/trailing ellipsis, then split on any remaining middle ones.
      const stripped = quoteTrim
        .replace(/^[\s.…]+/, "")
        .replace(/[\s.…]+$/, "");
      const parts = stripped
        .split(/\.{3}|…/)
        .map((p) => normalizeForMatch(p.trim()))
        .filter(Boolean);
      if (parts.length === 0) return null;

      const head = parts[0];
      const headIdx = normFull.indexOf(head);
      if (headIdx === -1) return null;

      if (parts.length === 1) {
        // Trailing or leading ellipsis only — anchor on the single fragment.
        startIdx = normToOriginal[headIdx];
        endIdx = normToOriginal[headIdx + head.length - 1] + 1;
      } else {
        // Middle ellipsis — anchor on head start and tail end.
        const tail = parts[parts.length - 1];
        const tailIdx = normFull.indexOf(tail, headIdx + head.length);
        if (tailIdx === -1) return null;
        startIdx = normToOriginal[headIdx];
        endIdx = normToOriginal[tailIdx + tail.length - 1] + 1;
      }
    }
  }

  if (endIdx > fullText.length) return null;

  function findNodeAndOffset(charIndex: number): { node: Text; offset: number } | null {
    for (let i = textNodes.length - 1; i >= 0; i--) {
      const { node, start } = textNodes[i];
      const nodeLen = node.length;
      if (charIndex >= start && charIndex <= start + nodeLen) {
        return { node, offset: charIndex - start };
      }
    }
    return null;
  }

  const startInfo = findNodeAndOffset(startIdx);
  const endInfo = findNodeAndOffset(endIdx - 1);
  if (!startInfo || !endInfo) return null;

  const range = doc.createRange();
  range.setStart(startInfo.node, startInfo.offset);
  const endOffset = endInfo.node === startInfo.node ? endInfo.offset + 1 : endInfo.offset + 1;
  range.setEnd(endInfo.node, Math.min(endOffset, endInfo.node.length));

  return range;
}

export interface BookConfig {
  location?: string;
  booknotes?: unknown[];
}

const defaultInsets = { top: 0, left: 0, right: 0, bottom: 0 };
const HIGHLIGHT_SWATCHES = ["yellow", "blue", "green", "pink"] as const;

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type Props = {
  bookKey: string;
  bookDoc: BookDoc;
  bookId: string | null;
  config?: BookConfig;
  insets?: { top: number; left: number; right: number; bottom: number };
  highlights?: Highlight[];
  onAddHighlight?: (highlight: Highlight) => void;
  onUpdateHighlight?: (highlight: Highlight) => void;
  onDeleteHighlight?: (id: string) => void;
  jumpToCfi?: string | null;
  onJumpHandled?: () => void;
  deleteNoteCfi?: string | null;
  onDeleteNoteCfiHandled?: () => void;
  onRelocate?: (payload: {
    cfi: string;
    tocHref?: string;
    tocLabel?: string;
    pageHref?: string;
    pageLabel?: string;
    pageCurrent?: number;
    pageTotal?: number;
  }) => void;
  /** Called when TOC navigation completes with payload; use to flush progress immediately. */
  onTocNavigateComplete?: (payload: {
    cfi: string;
    fraction: number;
  }) => void;
  onOpenNoteFromHighlight?: (cfi: string) => void;
  /** Add selection to a thread: pass threadId to add to that thread, or null for new thread. */
  onOpenAiPanel?: (
    selection: { cfi: string; selectedText: string; chapterLabel?: string; chapterHref?: string },
    targetThreadId: string | null
  ) => void;
  /** Threads for the current book (for dropdown). */
  threads?: Array<{ id: string; title?: string }>;
  /** Called when view is ready so parent can get current chapter text (pass tocHref to get that chapter only). */
  onRegisterGetSectionText?: (fn: ((tocHref?: string) => string) | null) => void;
  /** Called when view is ready so parent can get text around a CFI (for get_context tool). */
  onRegisterGetContextAroundCfi?: (fn: ((cfi: string, charRadius: number) => string) | null) => void;
  /** Called when view is ready so parent can resolve citation (quote) to CFI and jump + temporary highlight. */
  onRegisterResolveCitation?: (
    fn: ((citation: CitationPayload) => Promise<string | null>) | null
  ) => void;
  /** Used by resolver to find which section contains the quote (then goTo that section and resolve range in DOM). */
  getSectionContainingQuote?: (citation: CitationPayload) => Promise<{ spineIndex: number } | null>;
  theme?: ReaderTheme;
  onThemeChange?: (theme: ReaderTheme) => void;
  isCurrentBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onClose?: () => void;
};

type ToolbarSelection = {
  selectedText: string;
  cfi: string;
  anchorX: number;
  anchorY: number;
  selectedColor?: string;
  isAiNote?: boolean;
};

export default function FoliateViewer({
  bookKey,
  bookDoc,
  bookId = null,
  config = {},
  insets = defaultInsets,
  highlights = [],
  onAddHighlight,
  onUpdateHighlight,
  onDeleteHighlight,
  jumpToCfi,
  onJumpHandled,
  deleteNoteCfi,
  onDeleteNoteCfiHandled,
  onRelocate,
  onTocNavigateComplete,
  onOpenNoteFromHighlight,
  onOpenAiPanel,
  threads = [],
  onRegisterGetSectionText,
  onRegisterGetContextAroundCfi,
  onRegisterResolveCitation,
  getSectionContainingQuote,
  theme = "light",
  onThemeChange,
  isCurrentBookmarked = false,
  onToggleBookmark,
  onClose,
}: Props) {
  // Keep config in the barebones API surface for compatibility with upcoming phases.
  void config;
  const viewRef = useRef<FoliateView | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverPromptRef = useRef<HTMLDivElement | null>(null);
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null);
  const displayMenuRef = useRef<HTMLDivElement | null>(null);
  const doubleClickDisabled = useRef(true);
  const highlightsRef = useRef<Highlight[]>(highlights);
  highlightsRef.current = highlights;
  const themeRef = useRef<ReaderTheme>(theme);
  themeRef.current = theme;
  const locationRef = useRef<{
    tocHref?: string;
    tocLabel?: string;
    pageHref?: string;
    pageLabel?: string;
    pageCurrent?: number;
    pageTotal?: number;
  }>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setViewState] = useState<FoliateView | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ToolbarSelection | null>(null);
  const [addToThreadDropdownOpen, setAddToThreadDropdownOpen] = useState(false);
  const [hoveredNote, setHoveredNote] = useState<ToolbarSelection | null>(null);
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const interactionBlocked = pendingSelection != null;
  const chrome =
    theme === "dark"
      ? {
          controlBg: "rgba(255,255,255,0.08)",
          controlBorder: "rgba(255,255,255,0.24)",
          controlFg: "#f3f3f3",
          menuBg: "rgba(26,26,26,0.96)",
          menuItemBg: "rgba(255,255,255,0.08)",
          menuItemActiveBg: "rgba(255,255,255,0.2)",
          navBg: "rgba(32,32,32,0.9)",
          navBorder: "rgba(255,255,255,0.24)",
        }
      : {
          controlBg: "rgba(0,0,0,0.06)",
          controlBorder: "rgba(0,0,0,0.1)",
          controlFg: "#222",
          menuBg: "rgba(255,255,255,0.96)",
          menuItemBg: "rgba(0,0,0,0.05)",
          menuItemActiveBg: "rgba(0,0,0,0.12)",
          navBg: "rgba(250,249,247,0.85)",
          navBorder: "rgba(0,0,0,0.15)",
        };

  const goPrev = useCallback(async () => {
    const v = viewRef.current;
    if (!v) return;
    try {
      if (typeof v.prev === "function") {
        await v.prev();
        return;
      }
      if (v.renderer && typeof v.renderer.prev === "function") {
        await v.renderer.prev();
      }
    } catch (err) {
      console.error("[FoliateViewer] prev failed:", err);
    }
  }, []);

  const goNext = useCallback(async () => {
    const v = viewRef.current;
    if (!v) return;
    try {
      if (typeof v.next === "function") {
        await v.next();
        return;
      }
      if (v.renderer && typeof v.renderer.next === "function") {
        await v.renderer.next();
      }
    } catch (err) {
      console.error("[FoliateViewer] next failed:", err);
    }
  }, []);

  const handlePageFlip = useCallback(
    (msg: MessageEvent | React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (interactionBlocked) return;
      if (!(msg instanceof MessageEvent)) return;
      if (msg.data?.bookKey !== bookKey) return;
      // Click/tap page-turn is intentionally disabled.
    },
    [bookKey, interactionBlocked]
  );

  const handleTouchPageFlip = useCallback((_ev: CustomEvent) => {
    // prev/next already handled inside useTouchEvent
  }, []);

  const { onWheel } = useMouseEvent(bookKey, viewRef, handlePageFlip);
  const {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  } = useTouchEvent(bookKey, viewRef, handleTouchPageFlip);

  const handleSelection = useCallback(
    (selection: { selectedText: string; cfi: string; anchorX: number; anchorY: number }) => {
      setPendingSelection(selection);
    },
    []
  );

  const selectionPayload = pendingSelection
    ? {
        cfi: pendingSelection.cfi,
        selectedText: pendingSelection.selectedText,
        chapterLabel: locationRef.current.tocLabel,
        chapterHref: locationRef.current.tocHref,
      }
    : null;

  const handleAddToThread = useCallback(
    (targetThreadId: string | null) => {
      if (!selectionPayload || !onOpenAiPanel) return;
      onOpenAiPanel(selectionPayload, targetThreadId);
      setAddToThreadDropdownOpen(false);
      setPendingSelection(null);
    },
    [onOpenAiPanel, selectionPayload]
  );

  const handleQuickHighlight = useCallback(
    async (color: string) => {
      const selection = pendingSelection;
      const v = viewRef.current;
      if (!selection || !bookId) return;
      const existing = highlightsRef.current.find((h) => h.cfi === selection.cfi);

      if (existing) {
        if (!onUpdateHighlight) return;
        const updated: Highlight = {
          ...existing,
          color,
          chapterLabel: existing.chapterLabel ?? locationRef.current.tocLabel,
          chapterHref: existing.chapterHref ?? locationRef.current.tocHref,
        };
        onUpdateHighlight(updated);
        if (v?.addAnnotation) {
          await v.addAnnotation({ ...existing, value: existing.cfi }, true);
          await v.addAnnotation({ ...updated, value: updated.cfi });
        }
      } else {
        if (!onAddHighlight) return;
        const highlight: Highlight = {
          id: uniqueId(),
          bookId,
          cfi: selection.cfi,
          selectedText: selection.selectedText,
          color,
          chapterLabel: locationRef.current.tocLabel ?? undefined,
          chapterHref: locationRef.current.tocHref ?? undefined,
          createdAt: Date.now(),
        };
        onAddHighlight(highlight);
        if (v?.addAnnotation) {
          await v.addAnnotation({ ...highlight, value: highlight.cfi });
        }
      }
      setPendingSelection(null);
    },
    [bookId, onAddHighlight, onUpdateHighlight, pendingSelection]
  );

  const getToolbarPosition = useCallback((selection: ToolbarSelection) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;
    const height = 44;
    const width = Math.min(250, Math.max(210, viewportWidth - margin * 2));
    // Reserve top area for reader/app chrome (close, display, notes, TOC buttons).
    const topSafeZone = 62;

    let left = Math.max(
      margin,
      Math.min(viewportWidth - width - margin, selection.anchorX - width / 2)
    );

    const topAbove = selection.anchorY - height - 10;
    const topBelow = selection.anchorY + 12;
    const maxTop = Math.max(topSafeZone, viewportHeight - height - margin);

    // Prefer above, but move below when selection is near top chrome.
    let top = topAbove >= topSafeZone ? topAbove : topBelow;
    top = Math.max(topSafeZone, Math.min(maxTop, top));

    // Extra top-right collision guard (notes + display controls cluster).
    if (top <= topSafeZone + 8) {
      const topRightZoneStart = viewportWidth - 180;
      if (left + width > topRightZoneStart) {
        left = Math.max(margin, topRightZoneStart - width - 8);
      }
    }

    return { left, top, width };
  }, []);

  const getHoverPromptPosition = useCallback((selection: ToolbarSelection) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = 180;
    const height = 32;
    const margin = 12;
    const topSafeZone = 62;
    const gap = 8;

    let left = Math.max(
      margin,
      Math.min(viewportWidth - width - margin, selection.anchorX - width / 2)
    );
    const maxTop = Math.max(topSafeZone, viewportHeight - height - margin);
    const topAbove = selection.anchorY - height - gap;
    const topBelow = selection.anchorY + gap;
    // Keep the prompt tightly coupled to the highlight: prefer above; if blocked, place just below.
    let top = topAbove >= topSafeZone ? topAbove : topBelow;
    top = Math.max(topSafeZone, Math.min(maxTop, top));

    if (top <= topSafeZone + 8) {
      const topRightZoneStart = viewportWidth - 180;
      if (left + width > topRightZoneStart) {
        left = Math.max(margin, topRightZoneStart - width - 8);
      }
    }

    return { left, top };
  }, []);

  /** Get text for the current chapter (if tocHref matches a loaded doc) or the first loaded section. */
  const getCurrentSectionText = useCallback((tocHref?: string): string => {
    const v = viewRef.current;
    const contents = v?.renderer?.getContents?.() ?? [];
    if (contents.length === 0) return "";
    if (tocHref?.trim()) {
      // Strip fragment (#section2) — spine URIs don't include it
      const hrefBase = tocHref.split("#")[0].replace(/^\.\//, "");
      const doc = contents.find((entry) => {
        const uri = (entry.doc as Document & { documentURI?: string })?.documentURI ?? "";
        return uri.includes(hrefBase) || uri.endsWith(hrefBase);
      });
      if (doc?.doc?.body?.innerText) {
        return doc.doc.body.innerText.trim(); // no slice here — caller handles sizing
      }
    }
    // Fallback: first doc only (the one currently in view). NOT a concat — foliate-js
    // pre-loads adjacent spine items for scroll perf, so concatenating all would leak future content.
    const firstDoc = contents[0];
    return firstDoc?.doc?.body?.innerText?.trim() ?? "";
  }, []);

  /** Get text around a CFI for the get_context tool. Uses highlight's selectedText to find anchor. */
  const getContextAroundCfi = useCallback((cfi: string, charRadius: number): string => {
    const v = viewRef.current;
    const contents = v?.renderer?.getContents?.() ?? [];
    if (contents.length === 0) return "";

    // CFI format: epubcfi(/6/4[spine-id]!/...) — spine-id bracket is optional
    const spineId = cfi.match(/\[([^\]]+)\]/)?.[1] ?? "";
    const doc = spineId
      ? (contents.find((entry) => {
          const uri = (entry.doc as Document & { documentURI?: string })?.documentURI ?? "";
          return uri.includes(spineId);
        }) ?? contents[0])
      : contents[0];

    const fullText = doc?.doc?.body?.innerText?.trim() ?? "";
    if (!fullText) return "";

    const anchorHighlight = (highlightsRef.current ?? []).find((h) => h.cfi === cfi);
    const anchor = anchorHighlight?.selectedText ?? "";
    const idx = anchor ? fullText.indexOf(anchor) : -1;
    const center = idx !== -1 ? idx : Math.floor(fullText.length / 2);

    const start = Math.max(0, center - charRadius);
    const end = Math.min(fullText.length, center + charRadius);
    return fullText.slice(start, end);
  }, []);

  useEffect(() => {
    if (view && onRegisterGetSectionText) {
      onRegisterGetSectionText(getCurrentSectionText);
    }
    return () => {
      onRegisterGetSectionText?.(null);
    };
  }, [view, onRegisterGetSectionText, getCurrentSectionText]);

  useEffect(() => {
    if (view && onRegisterGetContextAroundCfi) {
      onRegisterGetContextAroundCfi(getContextAroundCfi);
    }
    return () => {
      onRegisterGetContextAroundCfi?.(null);
    };
  }, [view, onRegisterGetContextAroundCfi, getContextAroundCfi]);

  useEffect(() => {
    if (!view || !onRegisterResolveCitation) return;

    async function resolveCitation(citation: CitationPayload): Promise<string | null> {
      const v = viewRef.current;
      if (!v) return null;

      // Use short quote for search; when model only sends anchors or quote is huge, use anchorBefore.
      let quote = citation.quote?.trim();
      if (!quote || quote.length > 400) quote = citation.anchorBefore ?? "";
      quote = stripWrappingQuotes(quote);
      if (!quote) return null;

      const contents = v.renderer.getContents?.() ?? [];

      for (let i = 0; i < contents.length; i++) {
        const entry = contents[i];
        const doc = entry?.doc;
        if (!doc) continue;

        const range = findQuoteRangeInDocument(doc, quote);
        if (!range) continue;

        const spineIndex = entry?.index ?? i;
        const cfi = v.getCFI?.(spineIndex, range);
        if (!cfi) continue;

        await v.goTo(cfi);

        const tempId = "temp-citation-" + Date.now();
        const tempAnn = {
          id: tempId,
          value: cfi,
          color: "rgba(255,200,0,0.4)",
        };
        await v.addAnnotation?.(tempAnn);
        setTimeout(() => {
          v.addAnnotation?.(tempAnn, true);
        }, 4000);

        return cfi;
      }

      // getContents() only has the current section. Find which section has the quote
      // via getSectionContainingQuote (uses section.createDocument()), then goTo that
      // section and resolve the range in the now-loaded doc.
      if (!getSectionContainingQuote) return null;

      const sectionResult = await getSectionContainingQuote(citation);
      if (!sectionResult) return null;

      await (v.goTo as (target: string | number) => Promise<void>)(sectionResult.spineIndex);

      // Poll until getContents() reflects the new section (iframe navigation is async).
      let entry: { doc?: Document; index?: number } | undefined;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
        const contents = v.renderer.getContents?.() ?? [];
        const candidate = contents[0];
        if (candidate?.doc && candidate?.index === sectionResult.spineIndex) {
          entry = candidate;
          break;
        }
        // Section may have only one content entry with no index — try doc match too.
        if (candidate?.doc) {
          const range = findQuoteRangeInDocument(candidate.doc, quote);
          if (range) { entry = candidate; break; }
        }
      }
      const doc = entry?.doc;
      if (!doc) return null;

      const range = findQuoteRangeInDocument(doc, quote);
      if (!range) return null;

      const spineIndex = entry?.index ?? sectionResult.spineIndex;
      const cfi = v.getCFI?.(spineIndex, range);
      if (!cfi) return null;

      await v.goTo(cfi);

      const tempId = "temp-citation-" + Date.now();
      const tempAnn = {
        id: tempId,
        value: cfi,
        color: "rgba(255,200,0,0.4)",
      };
      await v.addAnnotation?.(tempAnn);
      setTimeout(() => {
        v.addAnnotation?.(tempAnn, true);
      }, 4000);

      return cfi;
    }

    onRegisterResolveCitation(resolveCitation);
    return () => {
      onRegisterResolveCitation(null);
    };
  }, [view, onRegisterResolveCitation, getSectionContainingQuote]);

  const {
    handleInstantAnnotationPointerDown,
    handleInstantAnnotationPointerMove,
    handleInstantAnnotationPointerCancel,
    handleInstantAnnotationPointerUp,
  } = useInstantAnnotation({ bookKey, viewRef, onSelection: handleSelection });

  const docLoadHandler = useCallback(
    (event: Event) => {
      setLoading(false); // hide spinner as soon as first doc loads
      const detail = (event as CustomEvent).detail;
      if (!detail?.doc) return;
      const doc = detail.doc as Document;
      if ((doc as Document & { isEventListenersAdded?: boolean }).isEventListenersAdded) return;
      (doc as Document & { isEventListenersAdded?: boolean }).isEventListenersAdded = true;

      doc.addEventListener("keydown", (e) => handleKeydown(bookKey, e as KeyboardEvent));
      doc.addEventListener("keyup", (e) => handleKeyup(bookKey, e as KeyboardEvent));
      doc.addEventListener("mousedown", (e) => handleMousedown(bookKey, e as MouseEvent));
      doc.addEventListener("mouseup", (e) => handleMouseup(bookKey, e as MouseEvent));
      doc.addEventListener("click", (e) =>
        handleClick(bookKey, doubleClickDisabled, e as MouseEvent)
      );
      doc.addEventListener("wheel", (e) => handleWheel(bookKey, e as WheelEvent), {
        passive: false,
      });
      doc.addEventListener("touchstart", (e) => handleTouchStart(bookKey, e as TouchEvent), {
        passive: true,
      });
      doc.addEventListener("touchmove", (e) => handleTouchMove(bookKey, e as TouchEvent), {
        passive: true,
      });
      doc.addEventListener("touchend", (e) => handleTouchEnd(bookKey, e as TouchEvent));

      const index = (detail as { index?: number }).index ?? 0;
      doc.addEventListener("pointerdown", (e) => {
        if (interactionBlocked) return;
        handleInstantAnnotationPointerDown(doc, index, e as PointerEvent);
      });
      doc.addEventListener("pointermove", (e) => {
        if (interactionBlocked) return;
        handleInstantAnnotationPointerMove(doc, index, e as PointerEvent);
      });
      doc.addEventListener("pointerup", (e) => {
        if (interactionBlocked) return;
        handleInstantAnnotationPointerUp(doc, index, e as PointerEvent);
      });
      doc.addEventListener("pointercancel", () => {
        handleInstantAnnotationPointerCancel();
      });

      const view = viewRef.current;
      // Inject theme into this section's doc so it persists when navigating back
      const styleId = "marginalia-theme";
      let styleEl = doc.getElementById(styleId);
      if (!styleEl) {
        styleEl = doc.createElement("style");
        styleEl.id = styleId;
        doc.head.appendChild(styleEl);
      }
      const css = getReaderStyles(themeRef.current);
      styleEl.textContent = css;

      if (view?.renderer?.setStyles) {
        view.renderer.setStyles(css);
      }
      // Re-add all highlights so they appear on this section when navigating
      const currentHighlights = highlightsRef.current;
      if (view?.addAnnotation && currentHighlights.length > 0) {
        currentHighlights.forEach((h) => {
          void view.addAnnotation!({ ...h, value: h.cfi });
        });
      }
    },
    [
      bookKey,
      interactionBlocked,
      handleInstantAnnotationPointerDown,
      handleInstantAnnotationPointerMove,
      handleInstantAnnotationPointerCancel,
      handleInstantAnnotationPointerUp,
    ]
  );

  const handleRelocate = useCallback((event?: Event) => {
    const v = viewRef.current;
    if (!v?.addAnnotation) return;
    const currentHighlights = highlightsRef.current;
    currentHighlights.forEach((h) => {
      void v.addAnnotation!({ ...h, value: h.cfi });
    });
    const detail = (event as CustomEvent | undefined)?.detail as
      | {
          cfi?: string;
          tocItem?: { href?: string; label?: string };
          pageItem?: { href?: string; label?: string };
          location?: { current?: number; next?: number; total?: number };
        }
      | undefined;
    const cfi = detail?.cfi;
    locationRef.current = {
      tocHref: detail?.tocItem?.href,
      tocLabel: detail?.tocItem?.label,
      pageHref: detail?.pageItem?.href,
      pageLabel: detail?.pageItem?.label,
      pageCurrent: detail?.location?.current,
      pageTotal: detail?.location?.total,
    };
    if (cfi) {
      onRelocate?.({
        cfi,
        tocHref: detail?.tocItem?.href,
        tocLabel: detail?.tocItem?.label,
        pageHref: detail?.pageItem?.href,
        pageLabel: detail?.pageItem?.label,
        pageCurrent: detail?.location?.current,
        pageTotal: detail?.location?.total,
      });
    }
  }, [onRelocate]);

  useFoliateEvents(view, { onRelocate: handleRelocate });

  const handleShowAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent).detail as { value?: string; range?: Range };
    const cfi = detail?.value;
    if (!cfi) return;
    const existing = highlightsRef.current.find((h) => h.cfi === cfi);
    if (!existing) return;
    const rect = detail.range?.getBoundingClientRect();
    setHoveredNote({
      selectedText: existing.selectedText ?? "",
      cfi,
      anchorX: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      anchorY: rect ? rect.top : 80,
      selectedColor: typeof existing.color === "string" ? existing.color : "yellow",
      isAiNote: false,
    });
  }, []);

  useEffect(() => {
    if (!view) return;
    view.addEventListener("show-annotation", handleShowAnnotation as EventListener);
    return () => view.removeEventListener("show-annotation", handleShowAnnotation as EventListener);
  }, [view, handleShowAnnotation]);

  const openNotesFromHover = useCallback(() => {
    if (!hoveredNote) return;
    onOpenNoteFromHighlight?.(hoveredNote.cfi);
    setHoveredNote(null);
  }, [hoveredNote, onOpenNoteFromHighlight]);

  const removeHighlightFromHover = useCallback(async () => {
    if (!hoveredNote) return;
    const existing = highlightsRef.current.find((h) => h.cfi === hoveredNote.cfi);
    if (!existing) {
      setHoveredNote(null);
      return;
    }
    onDeleteHighlight?.(existing.id);
    const v = viewRef.current;
    if (v?.addAnnotation) {
      await v.addAnnotation({ ...existing, value: existing.cfi }, true);
    }
    setHoveredNote(null);
  }, [hoveredNote, onDeleteHighlight]);

  useEffect(() => {
    if (!hoveredNote && !pendingSelection) return;
    const onWindowPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (hoverPromptRef.current?.contains(target)) return;
      if (selectionToolbarRef.current?.contains(target)) return;
      setHoveredNote(null);
      setPendingSelection(null);
    };
    window.addEventListener("mousedown", onWindowPointerDown);
    return () => window.removeEventListener("mousedown", onWindowPointerDown);
  }, [hoveredNote, pendingSelection]);

  useEffect(() => {
    if (!isDisplayMenuOpen) return;
    const onWindowPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (displayMenuRef.current?.contains(target)) return;
      setIsDisplayMenuOpen(false);
    };
    window.addEventListener("mousedown", onWindowPointerDown);
    return () => window.removeEventListener("mousedown", onWindowPointerDown);
  }, [isDisplayMenuOpen]);

  useEffect(() => {
    if (!jumpToCfi) return;
    const v = viewRef.current;
    if (!v) return;
    v.goTo(jumpToCfi).then(
      () => {
        // TOC navigation may not always fire relocate; explicitly save progress
        // when goTo completes so the new position is persisted.
        const loc = (v as FoliateView & {
          lastLocation?: {
            cfi?: string;
            fraction?: number;
            tocItem?: { href?: string; label?: string };
            pageItem?: { href?: string; label?: string };
            location?: { current?: number; total?: number };
          };
        }).lastLocation;
        if (loc?.cfi && onRelocate) {
          const tocItem = typeof loc.tocItem === "object" ? loc.tocItem : undefined;
          const pageItem = typeof loc.pageItem === "object" ? loc.pageItem : undefined;
          const location = typeof loc.location === "object" ? loc.location : undefined;
          onRelocate({
            cfi: loc.cfi,
            tocHref: tocItem?.href,
            tocLabel: tocItem?.label,
            pageHref: pageItem?.href,
            pageLabel: pageItem?.label,
            pageCurrent: location?.current,
            pageTotal: location?.total,
          });
          const fraction =
            typeof loc.fraction === "number"
              ? loc.fraction
              : location?.current != null && location?.total != null && location.total > 0
                ? (location.current + 1) / location.total
                : 0;
          onTocNavigateComplete?.({ cfi: loc.cfi, fraction });
        }
        onJumpHandled?.();
      },
      () => {
        onJumpHandled?.();
      }
    );
  }, [jumpToCfi, onJumpHandled, onRelocate, onTocNavigateComplete, view]);

  useEffect(() => {
    if (!deleteNoteCfi) return;
    const v = viewRef.current;
    if (!v?.addAnnotation) {
      onDeleteNoteCfiHandled?.();
      return;
    }
    const existing = highlightsRef.current.find((h) => h.cfi === deleteNoteCfi);
    if (existing) {
      void v.addAnnotation({ ...existing, value: existing.cfi }, true);
    }
    onDeleteNoteCfiHandled?.();
  }, [deleteNoteCfi, onDeleteNoteCfiHandled]);

  useEffect(() => {
    if (!view?.renderer) return;
    const css = getReaderStyles(theme);
    if (view.renderer.setStyles) {
      view.renderer.setStyles(css);
    }
    // Update injected theme styles in all mounted section docs.
    const contents = view.renderer.getContents?.() ?? [];
    contents.forEach(({ doc }) => {
      const styleEl = doc.getElementById("marginalia-theme");
      if (styleEl) {
        styleEl.textContent = css;
      }
    });
    // foliate paginator background sometimes lags behind style updates until section navigation.
    // Re-go to current CFI to force immediate background/chrome repaint in the active section.
    const cfi = (view as FoliateView & { lastLocation?: { cfi?: string } }).lastLocation?.cfi;
    if (cfi) {
      requestAnimationFrame(() => {
        void view.goTo(cfi);
      });
    }
  }, [view, theme]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        if (interactionBlocked) return;
        e.preventDefault();
        void goPrev();
      } else if (e.key === "ArrowRight") {
        if (interactionBlocked) return;
        e.preventDefault();
        void goNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goPrev, goNext, interactionBlocked]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setLoading(true);

    // Do not add a one-time guard (e.g. isViewCreated ref) here. In dev, React.StrictMode
    // runs effect setup then cleanup then setup again. A guard would skip the second run,
    // so the view would never be created after cleanup and the reader would stay blank.

    // Always clear loading after 2s so we never stay stuck (user can close or see errors)
    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 2000);

    (async () => {
      try {
        console.log("[FoliateViewer] importing foliate-js/view.js…");
        await import("foliate-js/view.js");
        if (cancelled) return;
        console.log("[FoliateViewer] view.js loaded, creating foliate-view");

        const view = document.createElement("foliate-view") as FoliateView;
        view.id = `foliate-view-${bookKey}`;
        // Fill container by absolute positioning so shadow-DOM content gets a real size
        Object.assign((view as HTMLElement).style, {
          position: "absolute",
          inset: "0",
          display: "block",
          width: "100%",
          height: "100%",
          minHeight: "0",
        });
        const container = containerRef.current;
        if (!container) {
          console.error("[FoliateViewer] no container ref");
          return;
        }
        container.appendChild(view);

        // Paginator uses container.getBoundingClientRect() for layout; it must be non-zero.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        });
        if (cancelled) return;

        if (bookDoc.transformTarget) {
          bookDoc.transformTarget.addEventListener("load", (e: Event) => {
            const ev = e as CustomEvent;
            if (ev.detail?.isScript) ev.detail.allow = false;
          });
          bookDoc.transformTarget.addEventListener("data", (e: Event) => {
            const ev = e as CustomEvent;
            ev.detail.data = Promise.resolve(ev.detail.data);
            if ("type" in ev.detail) ev.detail.type = Promise.resolve(ev.detail.type);
          });
        }

        view.addEventListener("load", docLoadHandler);

        console.log("[FoliateViewer] calling view.open(bookDoc)…");
        await view.open(bookDoc);
        if (cancelled) return;
        console.log("[FoliateViewer] view.open() done");

        viewRef.current = view;
        setViewState(view);

        if (view.renderer?.setStyles) {
          view.renderer.setStyles(getReaderStyles(theme));
        }

        if (jumpToCfi) {
          await view.goTo(jumpToCfi);
          console.log("[FoliateViewer] goTo(saved CFI) done");
        } else {
          await view.goToFraction(0);
          console.log("[FoliateViewer] goToFraction(0) done");
        }
      } catch (err) {
        console.error("[FoliateViewer] error:", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(safetyTimer);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      const view = viewRef.current;
      if (view && containerRef.current?.contains(view)) {
        view.close();
        view.remove();
      }
      viewRef.current = null;
      setViewState(null);
      setLoadError(null);
    };
  }, [bookKey, bookDoc]);

  return (
    <div
      ref={containerRef}
      className="foliate-viewer-container"
      style={{
        position: "absolute",
        top: insets.top,
        left: insets.left,
        right: insets.right,
        bottom: insets.bottom,
        width: "100%",
        height: "100%",
        minWidth: "100%",
        minHeight: "100%",
        overflow: "hidden",
      }}
      onClick={undefined}
      onWheel={
        interactionBlocked
          ? undefined
          : (e) => onWheel(e as unknown as React.WheelEvent<HTMLDivElement>)
      }
      onTouchStart={
        interactionBlocked ? undefined : (onTouchStart as (e: React.TouchEvent<HTMLDivElement>) => void)
      }
      onTouchMove={
        interactionBlocked ? undefined : (onTouchMove as (e: React.TouchEvent<HTMLDivElement>) => void)
      }
      onTouchEnd={
        interactionBlocked ? undefined : (onTouchEnd as (e: React.TouchEvent<HTMLDivElement>) => void)
      }
    >
      <Annotator view={view} highlights={highlights} />
      {/* Chrome overlay: inside viewer so it stacks above foliate-view and receives clicks */}
      {onClose != null && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 8px 0",
            pointerEvents: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                cursor: "pointer",
                background: chrome.controlBg,
                border: `1px solid ${chrome.controlBorder}`,
                borderRadius: 6,
                color: chrome.controlFg,
              }}
            >
              Close
            </button>
            {onToggleBookmark && (
              <button
                type="button"
                aria-label={isCurrentBookmarked ? "Remove bookmark" : "Add bookmark"}
                title={isCurrentBookmarked ? "Remove bookmark" : "Add bookmark"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleBookmark();
                }}
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
                  color: isCurrentBookmarked ? "#d97706" : chrome.controlFg,
                }}
              >
                <Bookmark size={16} fill={isCurrentBookmarked ? "currentColor" : "none"} />
              </button>
            )}
          </div>
          {onThemeChange != null && (
            <div ref={displayMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                aria-label="Display options"
                title="Display options"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsDisplayMenuOpen((prev) => !prev);
                }}
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
                <SlidersHorizontal size={16} />
              </button>
              {isDisplayMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 40,
                    zIndex: 140,
                    display: "flex",
                    gap: 4,
                    padding: 6,
                    borderRadius: 8,
                    border: `1px solid ${chrome.controlBorder}`,
                    background: chrome.menuBg,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.12)",
                  }}
                >
                  {(["light", "sepia", "dark"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onThemeChange(t);
                        setIsDisplayMenuOpen(false);
                      }}
                      title={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
                      aria-label={`${t.charAt(0).toUpperCase() + t.slice(1)} theme`}
                      style={{
                        padding: "6px 8px",
                        fontSize: 12,
                        cursor: "pointer",
                        background: theme === t ? chrome.menuItemActiveBg : chrome.menuItemBg,
                        border: `1px solid ${chrome.controlBorder}`,
                        borderRadius: 6,
                        fontWeight: theme === t ? 600 : 400,
                        color: chrome.controlFg,
                      }}
                    >
                      {t.charAt(0).toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {loading && (
        <div
          aria-live="polite"
          style={{
            position: "absolute",
            inset: 0,
            minHeight: 200,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#faf9f7",
            fontSize: 18,
            fontWeight: 500,
            color: "#333",
          }}
        >
          Loading…
        </div>
      )}
      {!loading && loadError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            right: 12,
            zIndex: 11,
            padding: "10px 12px",
            borderRadius: 8,
            fontSize: 13,
            background: "rgba(181, 26, 26, 0.1)",
            color: "#7a1515",
            border: "1px solid rgba(181, 26, 26, 0.35)",
          }}
        >
          Failed to load book: {loadError}
        </div>
      )}
      {!loading && !loadError && (
        <>
          <button
            type="button"
            aria-label="Previous page"
            onClick={() => void goPrev()}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 12,
              width: 34,
              height: 34,
              borderRadius: "999px",
              border: `1px solid ${chrome.navBorder}`,
              background: chrome.navBg,
              color: chrome.controlFg,
              cursor: "pointer",
            }}
          >
            {"<"}
          </button>
          <button
            type="button"
            aria-label="Next page"
            onClick={() => void goNext()}
            style={{
              position: "absolute",
              right: 12,
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 12,
              width: 34,
              height: 34,
              borderRadius: "999px",
              border: `1px solid ${chrome.navBorder}`,
              background: chrome.navBg,
              color: chrome.controlFg,
              cursor: "pointer",
            }}
          >
            {">"}
          </button>
        </>
      )}
      {hoveredNote && !pendingSelection && (
        <>
          <button
            type="button"
            aria-label="Dismiss highlight actions"
            onClick={() => setHoveredNote(null)}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 123,
              border: "none",
              background: "transparent",
              padding: 0,
              margin: 0,
            }}
          />
          <div
            ref={hoverPromptRef}
            style={{
              position: "absolute",
              left: getHoverPromptPosition(hoveredNote).left,
              top: getHoverPromptPosition(hoveredNote).top,
              zIndex: 124,
              borderRadius: 999,
              background: "rgba(34,34,34,0.92)",
              color: "#fff",
              padding: "5px 8px",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={openNotesFromHover}
              style={{
                border: "none",
                background: "transparent",
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {hoveredNote.isAiNote ? "Check AI note" : "Check highlights"}
            </button>
            {!hoveredNote.isAiNote && (
              <>
                <span style={{ opacity: 0.5 }}>|</span>
                <button
                  type="button"
                  onClick={() => void removeHighlightFromHover()}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Remove highlight
                </button>
              </>
            )}
          </div>
        </>
      )}
      {pendingSelection && (
        <>
          <button
            type="button"
            aria-label="Dismiss selection actions"
            onClick={() => setPendingSelection(null)}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 124,
              border: "none",
              background: "transparent",
              padding: 0,
              margin: 0,
            }}
          />
          <div
            ref={selectionToolbarRef}
            role="dialog"
            aria-label="Selection actions"
            style={{
              position: "absolute",
              left: getToolbarPosition(pendingSelection).left,
              top: getToolbarPosition(pendingSelection).top,
              zIndex: 125,
              width: getToolbarPosition(pendingSelection).width,
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "rgba(255,255,255,0.97)",
              boxShadow: "0 10px 24px rgba(0,0,0,0.16)",
              padding: "6px 8px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {HIGHLIGHT_SWATCHES.map((swatch) => {
              const selected = pendingSelection.selectedColor === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Highlight ${swatch}`}
                  onClick={() => void handleQuickHighlight(swatch)}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "999px",
                    border: selected ? "2px solid #111" : "1px solid rgba(0,0,0,0.2)",
                    background:
                      swatch === "yellow"
                        ? "#fde047"
                        : swatch === "blue"
                          ? "#93c5fd"
                          : swatch === "green"
                            ? "#86efac"
                            : "#f9a8d4",
                    cursor: "pointer",
                  }}
                />
              );
            })}
            <div style={{ width: 1, height: 20, background: "rgba(0,0,0,0.12)" }} />
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                onClick={() => setAddToThreadDropdownOpen((o) => !o)}
                aria-label="Add to thread"
                aria-expanded={addToThreadDropdownOpen}
                style={{
                  border: "1px solid rgba(0,0,0,0.12)",
                  borderRadius: 999,
                  padding: "4px 8px 4px 10px",
                  fontSize: 12,
                  background: "#fff",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                Add to thread
                <ChevronDown size={14} style={{ opacity: addToThreadDropdownOpen ? 0.7 : 0.5 }} />
              </button>
              {addToThreadDropdownOpen && (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: "100%",
                    marginTop: 4,
                    minWidth: 160,
                    maxHeight: 200,
                    overflow: "auto",
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "rgba(255,255,255,0.98)",
                    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                    padding: 4,
                    zIndex: 130,
                  }}
                >
                  {threads.length === 0 ? (
                    <div style={{ padding: "8px 10px", fontSize: 12, color: "#666" }}>
                      No threads yet
                    </div>
                  ) : (
                    threads.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="menuitem"
                        onClick={() => handleAddToThread(t.id)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "6px 10px",
                          border: "none",
                          borderRadius: 6,
                          background: "transparent",
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "rgba(0,0,0,0.06)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "transparent";
                        }}
                      >
                        {t.title?.trim() || "New thread"}
                      </button>
                    ))
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => handleAddToThread(null)}
                aria-label="New thread"
                style={{
                  border: "1px solid rgba(0,0,0,0.12)",
                  borderRadius: 999,
                  padding: 4,
                  background: "#fff",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
