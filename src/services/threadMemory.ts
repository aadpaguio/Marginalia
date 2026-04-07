import type { MemoryItem, ThreadMessage } from "@/types/book";

export function hasUserHistory(messages: ThreadMessage[]): boolean {
  return messages.some((m) => m.role === "user" && m.content.trim().length > 0);
}

export function shouldAcceptPreloadResult(
  activeThreadId: string | null,
  targetThreadId: string
): boolean {
  return activeThreadId === targetThreadId;
}

export function getFirstTurnMemoryPlan(params: {
  isFirstTurn: boolean;
  activeThreadId: string;
  loadedForThreadId: string | null;
  preloadedItems: MemoryItem[];
}): { mode: "use_preloaded" | "fetch_inline" | "none"; items?: MemoryItem[] } {
  if (!params.isFirstTurn) return { mode: "none" };
  if (
    params.loadedForThreadId === params.activeThreadId &&
    params.preloadedItems.length > 0
  ) {
    return { mode: "use_preloaded", items: params.preloadedItems };
  }
  return { mode: "fetch_inline" };
}
