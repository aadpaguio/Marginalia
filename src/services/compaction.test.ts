import { describe, it, expect } from "vitest";
import { extractChapterRange, isNearDuplicate } from "./compaction";

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
});
