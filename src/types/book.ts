/** Minimal book types for Marginalia. Only EPUB for now. */

export type BookFormat = "EPUB";

export type BookNoteType = "bookmark" | "annotation" | "excerpt";
export type HighlightStyle = "highlight" | "underline" | "squiggly";
export type HighlightColor = "red" | "yellow" | "green" | "blue" | "violet" | string;

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface BookNote {
  id: string;
  type: BookNoteType;
  bookId?: string;
  cfi: string;
  chapterLabel?: string;
  chapterHref?: string;
  pageLabel?: string;
  pageHref?: string;
  pageCurrent?: number;
  pageTotal?: number;
  selectedText?: string;
  text?: string;
  style?: HighlightStyle;
  color?: HighlightColor;
  note: string;
  aiConversation?: AIMessage[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

/** Highlight (threads schema): persisted highlight, can be attached to a thread. */
export type HighlightColorName = "yellow" | "blue" | "green" | "pink" | "red" | "violet";

export interface Highlight {
  id: string;
  bookId: string;
  cfi: string;
  selectedText: string;
  color: HighlightColorName | string;
  chapterLabel?: string;
  chapterHref?: string;
  createdAt: number;
  annotation?: string | null;
}

export interface Thread {
  id: string;
  bookId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** Set when mid-thread memory flush has run (idempotency). null = not flushed yet. */
  flushedAt?: number | null;
}

export interface WebCitation {
  url: string;
  title: string;
  citedText?: string;
}

export type ThreadToolEvent =
  | { type: "tool_call"; label: string }
  | { type: "tool_result"; label: string }
  | { type: "web_search_call"; query: string }
  | { type: "web_search_result"; label: string }
  | { type: "web_search_decision"; label: string };

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** Set only on role=user when message has an attached passage. */
  excerptText?: string | null;
  excerptCfi?: string | null;
  excerptChapter?: string | null;
  excerptColor?: string | null;
  excerptPage?: string | null;
  /** Web search citations attached to assistant messages. */
  webCitations?: WebCitation[] | null;
  /** Compact sequential tool/system events rendered before assistant content. */
  toolEvents?: ThreadToolEvent[] | null;
}

export interface ThreadWithMessages extends Thread {
  messages: ThreadMessage[];
  highlights: Highlight[];
}

/** Citation payload from assistant (HTML comment); used for jump-to-passage resolution. Quote may be omitted when comment precedes the passage (parser fills it). */
export interface CitationPayload {
  quote?: string;
  anchorBefore?: string;
  anchorAfter?: string;
  spineHint?: string | null;
}

// Phase 30: structured memory items (camelCase from Rust serde)
export type MemoryItemType =
  | "reading_identity"
  | "intellectual"
  | "emotional"
  | "preference"
  | "book_insight"
  | "book_question"
  | "book_reaction"
  | "cross_book_pattern";

export type MemoryItemSource = "compaction" | "user_explicit" | "extracted";

export type MemoryScope = "global" | "book" | "passage";

/** implicit = shape answer invisibly; callout_ok = may reference prior thread when natural. */
export type MemoryUsageMode = "implicit" | "callout_ok";

export interface MemoryAnchor {
  id: string;
  memoryId: string;
  bookId?: string | null;
  highlightId?: string | null;
  threadId?: string | null;
  cfi?: string | null;
  passageText?: string | null;
}

export interface MemoryItem {
  id: string;
  content: string;
  type: MemoryItemType;
  scope: MemoryScope;
  usageMode?: MemoryUsageMode;
  confidence: number;
  observationCount: number;
  source: MemoryItemSource;
  createdAt: number;
  lastReinforcedAt: number;
  anchors: MemoryAnchor[];
}
