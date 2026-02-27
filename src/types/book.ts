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
}

export interface Thread {
  id: string;
  bookId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

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
}

export interface ThreadWithMessages extends Thread {
  messages: ThreadMessage[];
  highlights: Highlight[];
}

/** Citation payload from assistant (HTML comment); used for jump-to-passage resolution. */
export interface CitationPayload {
  quote: string;
  anchorBefore?: string;
  anchorAfter?: string;
  spineHint?: string | null;
}
