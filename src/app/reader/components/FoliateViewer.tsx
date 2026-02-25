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
import { useAIPanel, type AIPanelSelection } from "../hooks/useAIPanel";
import Annotator from "./annotator/Annotator";
import type { BookNote } from "@/types/book";
import AIPanel from "@/components/AIPanel/AIPanel";
import { Bookmark, SlidersHorizontal } from "lucide-react";

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
  config?: BookConfig;
  insets?: { top: number; left: number; right: number; bottom: number };
  notes?: BookNote[];
  onAddNote?: (note: BookNote) => void;
  onUpdateNote?: (note: BookNote) => void;
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
  theme?: ReaderTheme;
  onThemeChange?: (theme: ReaderTheme) => void;
  isCurrentBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onClose?: () => void;
};

type ToolbarSelection = AIPanelSelection & {
  anchorX: number;
  anchorY: number;
  selectedColor?: string;
  isAiNote?: boolean;
};

export default function FoliateViewer({
  bookKey,
  bookDoc,
  config = {},
  insets = defaultInsets,
  notes = [],
  onAddNote,
  onUpdateNote,
  jumpToCfi,
  onJumpHandled,
  deleteNoteCfi,
  onDeleteNoteCfiHandled,
  onRelocate,
  onTocNavigateComplete,
  onOpenNoteFromHighlight,
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
  const notesRef = useRef<BookNote[]>(notes);
  notesRef.current = notes;
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
  const [hoveredNote, setHoveredNote] = useState<ToolbarSelection | null>(null);
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const { isOpen, currentSelection, openPanel, closePanel } = useAIPanel();
  const interactionBlocked = isOpen || pendingSelection != null;
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

  const handleAskAiFromSelection = useCallback(() => {
    if (!pendingSelection) return;
    openPanel({ selectedText: pendingSelection.selectedText, cfi: pendingSelection.cfi });
    setPendingSelection(null);
  }, [openPanel, pendingSelection]);

  const handleQuickHighlight = useCallback(
    async (color: string) => {
      const selection = pendingSelection;
      const v = viewRef.current;
      if (!selection || !onAddNote) return;
      const existing = notesRef.current.find((n) => n.cfi === selection.cfi && n.type === "annotation");

      if (existing) {
        const updated: BookNote = {
          ...existing,
          color,
          chapterLabel: existing.chapterLabel ?? locationRef.current.tocLabel,
          chapterHref: existing.chapterHref ?? locationRef.current.tocHref,
          pageLabel: locationRef.current.pageLabel ?? existing.pageLabel,
          pageHref: locationRef.current.pageHref ?? existing.pageHref,
          pageCurrent: locationRef.current.pageCurrent ?? existing.pageCurrent,
          pageTotal: locationRef.current.pageTotal ?? existing.pageTotal,
          updatedAt: Date.now(),
        };
        onUpdateNote?.(updated);
        if (v?.addAnnotation) {
          await v.addAnnotation({ ...existing, value: existing.cfi }, true);
          await v.addAnnotation({ ...updated, value: updated.cfi });
        }
      } else {
        const note: BookNote = {
          id: uniqueId(),
          type: "annotation",
          cfi: selection.cfi,
          chapterLabel: locationRef.current.tocLabel,
          chapterHref: locationRef.current.tocHref,
          pageLabel: locationRef.current.pageLabel,
          pageHref: locationRef.current.pageHref,
          pageCurrent: locationRef.current.pageCurrent,
          pageTotal: locationRef.current.pageTotal,
          selectedText: selection.selectedText,
          text: selection.selectedText,
          style: "highlight",
          color,
          note: "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        onAddNote(note);
        if (v?.addAnnotation) {
          await v.addAnnotation({ ...note, value: note.cfi });
        }
      }
      setPendingSelection(null);
    },
    [onAddNote, onUpdateNote, pendingSelection]
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

  const getCurrentSectionText = useCallback((_cfi: string): string => {
    const v = viewRef.current;
    const docs = v?.renderer?.getContents?.() ?? [];
    const text = docs
      .map((entry) => entry.doc?.body?.innerText?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");
    // Keep a large stable context block for Claude prompt caching (Haiku 4.5 needs 4096+ cacheable tokens).
    return text.slice(0, 50000);
  }, []);

  const handleSaveAiNote = useCallback(
    (note: BookNote) => {
      const v = viewRef.current;
      if (!onAddNote) return;
      const existing = notesRef.current.find((n) => n.cfi === note.cfi && n.type === "annotation");
      if (existing) {
        const merged: BookNote = {
          ...existing,
          ...note,
          id: existing.id,
          color: note.color ?? existing.color,
          chapterLabel:
            note.chapterLabel ?? existing.chapterLabel ?? locationRef.current.tocLabel,
          chapterHref: note.chapterHref ?? existing.chapterHref ?? locationRef.current.tocHref,
          pageLabel: note.pageLabel ?? locationRef.current.pageLabel ?? existing.pageLabel,
          pageHref: note.pageHref ?? locationRef.current.pageHref ?? existing.pageHref,
          pageCurrent: note.pageCurrent ?? locationRef.current.pageCurrent ?? existing.pageCurrent,
          pageTotal: note.pageTotal ?? locationRef.current.pageTotal ?? existing.pageTotal,
          updatedAt: Date.now(),
        };
        onUpdateNote?.(merged);
      } else {
        onAddNote({
          ...note,
          chapterLabel: note.chapterLabel ?? locationRef.current.tocLabel,
          chapterHref: note.chapterHref ?? locationRef.current.tocHref,
          pageLabel: note.pageLabel ?? locationRef.current.pageLabel,
          pageHref: note.pageHref ?? locationRef.current.pageHref,
          pageCurrent: note.pageCurrent ?? locationRef.current.pageCurrent,
          pageTotal: note.pageTotal ?? locationRef.current.pageTotal,
        });
      }
      if (v?.addAnnotation) {
        void v.addAnnotation({ ...note, value: note.cfi });
      }
    },
    [onAddNote, onUpdateNote]
  );

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
      // Re-add all notes so highlights appear on this section when navigating
      const currentNotes = notesRef.current;
      if (view?.addAnnotation && currentNotes.length > 0) {
        currentNotes.forEach((n) => {
          if (!n.deletedAt && n.type === "annotation") {
            void view.addAnnotation!({ ...n, value: n.cfi });
          }
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
    const currentNotes = notesRef.current;
    currentNotes.forEach((n) => {
      if (!n.deletedAt && n.type === "annotation") {
        void v.addAnnotation!({ ...n, value: n.cfi });
      }
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
    const existing = notesRef.current.find((n) => n.cfi === cfi && n.type === "annotation");
    if (!existing) return;
    const rect = detail.range?.getBoundingClientRect();
    setHoveredNote({
      selectedText: existing.selectedText ?? existing.text ?? "",
      cfi,
      anchorX: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      anchorY: rect ? rect.top : 80,
      selectedColor: typeof existing.color === "string" ? existing.color : "yellow",
      isAiNote: (existing.aiConversation?.length ?? 0) > 0,
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
    const existing = notesRef.current.find((n) => n.cfi === hoveredNote.cfi && n.type === "annotation");
    if (!existing) {
      setHoveredNote(null);
      return;
    }
    onUpdateNote?.({
      ...existing,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const v = viewRef.current;
    if (v?.addAnnotation) {
      await v.addAnnotation({ ...existing, value: existing.cfi }, true);
    }
    setHoveredNote(null);
  }, [hoveredNote, onUpdateNote]);

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
    const existing = notesRef.current.find((n) => n.cfi === deleteNoteCfi && n.type === "annotation");
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
      <Annotator view={view} notes={notes} />
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
      {isOpen && currentSelection && (
        <AIPanel
          selection={currentSelection}
          bookTitle={bookDoc.metadata.title || "Untitled"}
          author={bookDoc.metadata.author || "Unknown"}
          getContext={getCurrentSectionText}
          onSave={handleSaveAiNote}
          onDismiss={closePanel}
        />
      )}
      {hoveredNote && !pendingSelection && !isOpen && (
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
      {pendingSelection && !isOpen && (
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
            <button
              type="button"
              onClick={handleAskAiFromSelection}
              style={{
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 999,
                padding: "4px 10px",
                fontSize: 12,
                background: "#fff",
                cursor: "pointer",
              }}
            >
              Ask AI
            </button>
          </div>
        </>
      )}
    </div>
  );
}
