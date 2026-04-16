export type ContextTurnMode =
  | "passage_attached"
  | "inherited_anchor"
  | "freeform";
export type ContextAnchorSource = "current" | "inherited" | "none";

export interface ContextManifestToolCall {
  tool: string;
  round: number;
  inputSummary: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ContextManifest {
  id: string;
  threadId: string;
  bookId: string;
  createdAt: number;

  turnMode: ContextTurnMode;
  activeAnchorPresent: boolean;
  activeAnchorSource: ContextAnchorSource;
  activeAnchorCfi?: string | null;
  activeAnchorChapter?: string | null;

  systemPromptChars: number;
  readerProfileIncluded: boolean;
  readerProfileChars?: number;
  bookMemoryIncluded: boolean;
  bookMemoryChars?: number;
  bookOverviewIncluded: boolean;
  highlightsCount: number;
  highlightsCfis: string[];
  historyMessageCount: number;
  memoryItemsCount: number;
  estimatedInputTokens?: number;

  toolsAvailable: string[];
  smartScanStatus?: "none" | "in_progress" | "done";

  toolCallsMade?: ContextManifestToolCall[];
  finalAnswerChars?: number;
  webSearchesUsed?: number;
}
