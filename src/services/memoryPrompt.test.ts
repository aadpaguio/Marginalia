import { describe, expect, it } from "vitest";
import type { MemoryItem } from "@/types/book";
import {
  formatMemoryItemsSystemBlock,
  promptReadyMemoryItem,
  sanitizeMemoryContentForPrompt,
  shouldIncludeMemoryItemForQuery,
} from "./memoryPrompt";

function mi(partial: Partial<MemoryItem> & Pick<MemoryItem, "id" | "content" | "type" | "scope">): MemoryItem {
  return {
    confidence: 0.8,
    observationCount: 1,
    source: "compaction",
    createdAt: 0,
    lastReinforcedAt: 0,
    anchors: [],
    ...partial,
  };
}

describe("memoryPrompt", () => {
  it("sanitizeMemoryContentForPrompt strips conversational callbacks and keeps substantive tail", () => {
    expect(sanitizeMemoryContentForPrompt("You asked before about grounding ideas in concrete images.")).toContain(
      "grounding ideas"
    );
    expect(sanitizeMemoryContentForPrompt("You asked before about grounding ideas in concrete images.") ?? "").not.toMatch(
      /you asked before/i
    );
    expect(
      sanitizeMemoryContentForPrompt(
        "You asked before about grounding. You prefer abstract claims tied to physical process."
      )
    ).toContain("prefer abstract claims");
    expect(sanitizeMemoryContentForPrompt("You prefer abstract claims tied to physical process.") ?? "").not.toMatch(
      /you asked before/i
    );
  });

  it("formatMemoryItemsSystemBlock includes type, scope, usageMode, optional thread, content", () => {
    const pr = promptReadyMemoryItem(
      mi({
        id: "1",
        content: "You prefer concise, direct replies when discussing literature.",
        type: "preference",
        scope: "global",
        usageMode: "implicit",
        anchors: [{ id: "a", memoryId: "1", threadId: "th-99" }],
      })
    );
    expect(pr).not.toBeNull();
    const block = formatMemoryItemsSystemBlock([pr!]);
    expect(block).toContain("type: preference");
    expect(block).toContain("scope: global");
    expect(block).toContain("usageMode: implicit");
    expect(block).toContain("thread: th-99");
    expect(block).toContain("content: You prefer concise, direct replies when discussing literature.");
  });

  it("shouldIncludeMemoryItemForQuery drops cross_book_pattern when query is unrelated", () => {
    const item = mi({
      id: "cb",
      content: "Reader often compares modernist fragmentation across Woolf and Joyce.",
      type: "cross_book_pattern",
      scope: "global",
    });
    expect(shouldIncludeMemoryItemForQuery(item, "What does this sentence mean?", "b1")).toBe(false);
    expect(
      shouldIncludeMemoryItemForQuery(item, "How does this relate to Joyce and fragmentation?", "b1")
    ).toBe(true);
  });
});
