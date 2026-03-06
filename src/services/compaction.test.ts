import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractChapterRange, extractMemoryItemsPartial, isNearDuplicate } from "./compaction";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("Phase 30 — compaction helpers", () => {
  describe("extractChapterRange", () => {
    it("returns empty string when no highlights", () => {
      expect(extractChapterRange([])).toBe("");
    });

    it("returns single chapter label when one highlight", () => {
      expect(
        extractChapterRange([{ chapterLabel: "Chapter 3" }])
      ).toBe("Chapter 3");
    });

    it("returns range when multiple chapters", () => {
      expect(
        extractChapterRange([
          { chapterLabel: "Chapter 5" },
          { chapterLabel: "Chapter 3" },
          { chapterLabel: "Chapter 4" },
        ])
      ).toBe("Chapter 3–Chapter 5");
    });

    it("ignores null/empty chapterLabel", () => {
      expect(
        extractChapterRange([
          { chapterLabel: null },
          { chapterLabel: "Chapter 1" },
          { chapterLabel: "" },
        ])
      ).toBe("Chapter 1");
    });

    it("sorts by leading number so Chapter 10 comes after Chapter 2", () => {
      expect(
        extractChapterRange([
          { chapterLabel: "Chapter 10" },
          { chapterLabel: "Chapter 2" },
        ])
      ).toBe("Chapter 2–Chapter 10");
    });
  });

  describe("isNearDuplicate", () => {
    it("returns true for identical normalized strings", () => {
      expect(isNearDuplicate("You tend to X.", "You tend to X.")).toBe(true);
    });

    it("returns true when one contains the other", () => {
      expect(
        isNearDuplicate("You tend to distrust narrators.", "You tend to distrust narrators who over-justify.")
      ).toBe(true);
    });

    it("returns false for unrelated short strings", () => {
      expect(isNearDuplicate("You like cats.", "You prefer dogs.")).toBe(false);
    });
  });

  describe("extractMemoryItemsPartial (mid-thread flush)", () => {
    beforeEach(() => {
      vi.mocked(invoke).mockReset();
    });

    it("returns only items with confidence >= 0.7", async () => {
      vi.mocked(invoke).mockResolvedValue({
        answer: JSON.stringify([
          { content: "Low confidence.", type: "book_insight", confidence: 0.5, scope: "book", passage_text: null },
          { content: "You prefer clear answers.", type: "preference", confidence: 0.8, scope: "global", passage_text: null },
        ]),
      });
      const result = await extractMemoryItemsPartial({
        thread: { id: "t1", bookId: "b1", title: "Discussion", createdAt: 0, updatedAt: 0, archived: false },
        messages: [],
        bookId: "b1",
        bookTitle: "Book",
        author: "Author",
        apiKey: "key",
      });
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("You prefer clear answers.");
      expect(result[0].confidence).toBe(0.8);
    });

    it("returns empty array on parse error", async () => {
      vi.mocked(invoke).mockResolvedValue({ answer: "not json" });
      const result = await extractMemoryItemsPartial({
        thread: { id: "t1", bookId: "b1", createdAt: 0, updatedAt: 0, archived: false },
        messages: [],
        bookId: "b1",
        bookTitle: "Book",
        author: "Author",
        apiKey: "key",
      });
      expect(result).toEqual([]);
    });

    it("uses user-turn count for threshold (no journal write)", async () => {
      vi.mocked(invoke).mockResolvedValue({ answer: "[]" });
      const result = await extractMemoryItemsPartial({
        thread: { id: "t1", bookId: "b1", createdAt: 0, updatedAt: 0, archived: false },
        messages: [
          { id: "1", threadId: "t1", role: "user", content: "Q1", createdAt: 0 },
          { id: "2", threadId: "t1", role: "assistant", content: "A1", createdAt: 0 },
        ],
        bookId: "b1",
        bookTitle: "Book",
        author: "Author",
        apiKey: "key",
      });
      expect(result).toEqual([]);
      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });
});
