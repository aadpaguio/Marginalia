import { describe, it, expect, vi, beforeEach } from "vitest";
import { assembleThreadContext, askClaudeThread } from "./claude";
import type { ThreadContextParams } from "./claude";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("Phase 27 — assembleThreadContext (blind model posture)", () => {
  const baseParams: ThreadContextParams = {
    threadId: "t1",
    messages: [],
    attachedHighlights: [],
    userMessage: "What does this mean?",
    bookTitle: "Test Book",
    author: "Test Author",
    bookId: "b1",
  };

  it("returns a single system block (no chapter text block)", () => {
    const result = assembleThreadContext(baseParams);
    expect(result.systemBlocks).toHaveLength(1);
    expect(result.systemBlocks[0].text).toContain("Marginalia");
    expect(result.systemBlocks[0].text).toContain("get_context");
    expect(result.systemBlocks[0].text).not.toContain("Here's the chapter's text");
  });

  it("includes highlights and user message in the user turn when highlights exist", () => {
    const params: ThreadContextParams = {
      ...baseParams,
      attachedHighlights: [
        {
          id: "h1",
          bookId: "b1",
          cfi: "epubcfi(/6/4!/4/2/1:0)",
          selectedText: "selected phrase",
          color: "yellow",
          chapterLabel: "Chapter 1",
          chapterHref: "ch1.xhtml",
          createdAt: 0,
        },
      ],
      userMessage: "Explain this.",
    };
    const result = assembleThreadContext(params);
    expect(result.messages).toHaveLength(1);
    const userTurn = result.messages[0];
    expect(userTurn.role).toBe("user");
    expect(typeof userTurn.content).toBe("string");
    const content = userTurn.content as string;
    expect(content).toContain("Chapter 1");
    expect(content).toContain("selected phrase");
    expect(content).toContain("Explain this.");
  });

  it("user turn is only the message when there are no highlights", () => {
    const result = assembleThreadContext(baseParams);
    expect(result.messages[0].content).toBe("What does this mean?");
  });

  it("includes pendingExcerpt in current turn even without attached highlights", () => {
    const result = assembleThreadContext({
      ...baseParams,
      pendingExcerpt: {
        text: "selected phrase from reader",
        cfi: "epubcfi(/6/10!/4/2/1:0)",
        chapter: "Chapter 3",
      },
      userMessage: "Can you unpack this?",
    });
    const content = result.messages[0].content as string;
    expect(content).toContain("Chapter 3");
    expect(content).toContain("epubcfi(/6/10!/4/2/1:0)");
    expect(content).toContain("selected phrase from reader");
    expect(content).toContain("Can you unpack this?");
  });

  it("Phase 30.5: injects memory items as first user message when memoryItems provided", () => {
    const result = assembleThreadContext({
      ...baseParams,
      memoryItems: [
        {
          id: "mi-1",
          content: "You tend to distrust narrators who over-justify.",
          type: "intellectual",
          confidence: 0.82,
          observationCount: 4,
          source: "compaction",
          createdAt: 0,
          lastReinforcedAt: 0,
          anchors: [],
        },
      ],
    });
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toContain("[MEMORY CONTEXT]");
    expect(first.content).toContain("[/MEMORY CONTEXT]");
    expect(first.content).toContain("You tend to distrust narrators");
    expect(first.content).toContain("intellectual");
    expect(first.content).toContain("4×");
  });

  it("Phase 30.5: no memory block when memoryItems empty or undefined", () => {
    const result = assembleThreadContext(baseParams);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0].content as string)).not.toContain("[MEMORY CONTEXT]");
  });
});

describe("Phase 27 — askClaudeThread agentic loop", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("returns answer immediately when response has no toolCalls", async () => {
    vi.mocked(invoke).mockResolvedValue({
      answer: "The passage means X.",
      toolCalls: [],
      rawContent: [{ type: "text", text: "The passage means X." }],
      model: "claude-haiku-4-5-20251001",
    });

    const result = await askClaudeThread(
      {
        threadId: "t1",
        messages: [],
        attachedHighlights: [],
        userMessage: "What does this mean?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        getContextAroundCfi: () => "",
      },
      "test-api-key"
    );

    expect(result.answer).toBe("The passage means X.");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("calls getContextAroundCfi and invokes again when response has get_context toolCall", async () => {
    const getContextAroundCfi = vi.fn().mockReturnValue("some context text");
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        answer: "",
        toolCalls: [
          {
            name: "get_context",
            id: "toolu_1",
            input: { cfi: "epubcfi(/6/4!/4/2)", char_radius: 3000 },
          },
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_context",
            input: { cfi: "epubcfi(/6/4!/4/2)", char_radius: 3000 },
          },
        ],
        model: "claude-haiku-4-5-20251001",
      })
      .mockResolvedValueOnce({
        answer: "Based on the context, the answer is Y.",
        toolCalls: [],
        rawContent: [
          { type: "text", text: "Based on the context, the answer is Y." },
        ],
        model: "claude-haiku-4-5-20251001",
      });

    const result = await askClaudeThread(
      {
        threadId: "t1",
        messages: [],
        attachedHighlights: [
          {
            id: "h1",
            bookId: "b1",
            cfi: "epubcfi(/6/4!/4/2)",
            selectedText: "phrase",
            color: "yellow",
            createdAt: 0,
          },
        ],
        userMessage: "What is the emotional arc here?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        getContextAroundCfi,
      },
      "test-api-key"
    );

    expect(result.answer).toBe("Based on the context, the answer is Y.");
    expect(getContextAroundCfi).toHaveBeenCalledWith("epubcfi(/6/4!/4/2)", 3000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
