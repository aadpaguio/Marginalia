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
});

describe("Phase 27 — askClaudeThread agentic loop", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("returns answer immediately when response has no tool_calls", async () => {
    vi.mocked(invoke).mockResolvedValue({
      answer: "The passage means X.",
      tool_calls: [],
      raw_content: [{ type: "text", text: "The passage means X." }],
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

  it("calls getContextAroundCfi and invokes again when response has get_context tool_call", async () => {
    const getContextAroundCfi = vi.fn().mockReturnValue("some context text");
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        answer: "",
        tool_calls: [
          {
            name: "get_context",
            id: "toolu_1",
            input: { cfi: "epubcfi(/6/4!/4/2)", char_radius: 3000 },
          },
        ],
        raw_content: [
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
        tool_calls: [],
        raw_content: [
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
