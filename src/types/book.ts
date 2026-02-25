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
