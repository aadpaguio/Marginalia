import { describe, expect, it } from "vitest";
import type { MemoryItem, ThreadMessage } from "@/types/book";
import {
  getFirstTurnMemoryPlan,
  hasUserHistory,
  shouldAcceptPreloadResult,
} from "./threadMemory";

const memory: MemoryItem = {
  id: "mi-1",
  content: "Reader often compares narrators across books.",
  type: "reading_identity",
  confidence: 0.8,
  observationCount: 2,
  source: "compaction",
  createdAt: 1,
  lastReinforcedAt: 1,
  anchors: [],
};

describe("thread memory guards", () => {
  it("rejects stale preload results after thread switch", () => {
    expect(shouldAcceptPreloadResult("thread-b", "thread-a")).toBe(false);
  });

  it("only allows preload for threads with real user content", () => {
    const empty: ThreadMessage[] = [
      { id: "a", threadId: "t", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    const withUser: ThreadMessage[] = [
      { id: "b", threadId: "t", role: "user", content: "Why this metaphor?", createdAt: 2 },
    ];
    expect(hasUserHistory(empty)).toBe(false);
    expect(hasUserHistory(withUser)).toBe(true);
  });

  it("forces deterministic inline fetch on first turn when preload missing", () => {
    const plan = getFirstTurnMemoryPlan({
      isFirstTurn: true,
      activeThreadId: "thread-a",
      loadedForThreadId: null,
      preloadedItems: [],
    });
    expect(plan.mode).toBe("fetch_inline");
  });

  it("uses preloaded memory only for matching thread id", () => {
    const plan = getFirstTurnMemoryPlan({
      isFirstTurn: true,
      activeThreadId: "thread-a",
      loadedForThreadId: "thread-a",
      preloadedItems: [memory],
    });
    expect(plan.mode).toBe("use_preloaded");
  });
});
