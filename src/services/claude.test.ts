import { describe, it, expect, vi, beforeEach } from "vitest";
import { assembleThreadContext, askClaudeThread, type GetContextResult } from "./claude";
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

  it("always includes READER PROFILE block (placeholder when empty)", () => {
    const result = assembleThreadContext(baseParams);
    expect(result.systemBlocks[0].text).toContain("--- READER PROFILE ---");
    expect(result.systemBlocks[0].text).toContain("(No reader profile yet.)");
  });

  it("includes actual reader profile when provided", () => {
    const result = assembleThreadContext({
      ...baseParams,
      readerProfile: "You enjoy close reading and thematic analysis.",
    });
    expect(result.systemBlocks[0].text).toContain("--- READER PROFILE ---");
    expect(result.systemBlocks[0].text).toContain("You enjoy close reading and thematic analysis.");
    expect(result.systemBlocks[0].text).not.toContain("(No reader profile yet.)");
  });

  it("TOOLS & CONTEXT: two normal turn types and get_context with direction", () => {
    const result = assembleThreadContext(baseParams);
    const text = result.systemBlocks[0].text;
    expect(text).toContain("Two normal turn types");
    expect(text).toContain("--- RETRIEVAL PATTERNS ---");
    expect(text).toContain("Close reading:");
    expect(text).toContain("Local expansion:");
    expect(text).toContain("Orient then decide:");
    expect(text).toContain(
      "Do not call get_section_text without consulting a section summary first for that spine_href unless the reader explicitly asks"
    );
    expect(text).toContain("Cross-section:");
    expect(text).toContain("Start with the lightest strategy that fits the question. Escalate only when needed.");
    expect(text).toContain("When a passage is attached to the message");
    expect(text).toContain("freeform thread question");
    expect(text).toContain("no passage is attached");
    expect(text).toContain("Only ask the user to point to the text again when there is no active anchor");
    expect(text).toContain("no need to ask first");
    expect(text).toContain("from_section_start");
    expect(text).toContain("atSectionStart");
    expect(text).toContain("Broader scope:");
    expect(text).toContain("ask before fetching or summarising");
  });

  it("evaluation tools preset adds only close-reading and local-expansion retrieval guidance", () => {
    const result = assembleThreadContext({
      ...baseParams,
      evaluationToolPreset: "tools",
    });
    const text = result.systemBlocks[0].text;
    expect(text).toContain("--- RETRIEVAL PATTERNS ---");
    expect(text).toContain("Close reading:");
    expect(text).toContain("Local expansion:");
    expect(text).toContain("Treat these as heuristics, not rigid pipelines.");
    expect(text).toContain("Start with the lightest strategy that fits the question. Escalate only when needed.");
    expect(text).not.toContain("Orient then decide:");
    expect(text).not.toContain("Cross-section:");
  });

  it("TOOLS & CONTEXT: attribution must not be answered by inference or guess; must fetch if not explicit", () => {
    const result = assembleThreadContext(baseParams);
    const text = result.systemBlocks[0].text;
    expect(text).toContain("Attribution and source-identification:");
    expect(text).toContain("Do not answer attribution questions");
    expect(text).toContain("by inference or prior knowledge");
    expect(text).toContain("do not guess");
    expect(text).toContain("you must call get_context before answering");
    expect(text).toContain("CURRENT TURN LEAD-UP CONTEXT");
    expect(text).toContain("explicitly name the source");
    expect(text).not.toContain("For most questions the passage alone is enough");
  });

  it("TOOLS & CONTEXT: when before does not resolve attribution, prefer around or after", () => {
    const result = assembleThreadContext(baseParams);
    const text = result.systemBlocks[0].text;
    expect(text).toContain("when the lead-up (before) context does not resolve the attribution");
    expect(text).toContain("direction 'around' or 'after'");
    expect(text).toContain("answer only from what the fetched text explicitly states");
  });

  it("includes turn-scoped prefetched lead-up block when prefetchedLeadUpContext provided", () => {
    const result = assembleThreadContext({
      ...baseParams,
      pendingExcerpt: {
        text: "selected phrase",
        cfi: "epubcfi(/6/4!/4/2/1:0)",
        chapter: "Chapter 1",
      },
      prefetchedLeadUpContext: "Earlier in the chapter the narrator described the sanatorium.",
    });
    expect(result.systemBlocks.length).toBeGreaterThanOrEqual(2);
    const leadUpBlock = result.systemBlocks.find((b) =>
      b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---")
    );
    expect(leadUpBlock).toBeDefined();
    expect(leadUpBlock!.text).toContain("Earlier in the chapter the narrator described the sanatorium.");
    expect(leadUpBlock!.text).toContain("this turn only");
  });

  it("no prefetched lead-up block when prefetchedLeadUpContext absent", () => {
    const result = assembleThreadContext({
      ...baseParams,
      pendingExcerpt: {
        text: "selected",
        cfi: "epubcfi(/6/4!/4/2/1:0)",
        chapter: "Ch 1",
      },
    });
    const hasLeadUp = result.systemBlocks.some((b) =>
      b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---")
    );
    expect(hasLeadUp).toBe(false);
  });

  it("includes highlights and user message in the user turn when passage attached this turn (pendingExcerpt)", () => {
    const params: ThreadContextParams = {
      ...baseParams,
      attachedHighlights: [],
      pendingExcerpt: {
        text: "selected phrase",
        cfi: "epubcfi(/6/4!/4/2/1:0)",
        chapter: "Chapter 1",
      },
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

  it("user turn includes freeform-thread marker and message when no passage attached", () => {
    const result = assembleThreadContext(baseParams);
    const content = result.messages[0].content as string;
    expect(content).toContain("(No passage is attached to this message.)");
    expect(content).toContain("What does this mean?");
  });

  it("when no passage on current turn but thread has recent excerpt, adds ACTIVE THREAD PASSAGE (inherited) and anchor notice", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        {
          id: "m1",
          threadId: "t1",
          role: "user",
          content: "What does the narrator mean by this?",
          createdAt: 1000,
          excerptText: "a pall falling over the land",
          excerptCfi: "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
          excerptChapter: "On dispersal",
        },
        {
          id: "m2",
          threadId: "t1",
          role: "assistant",
          content: "The narrator is suggesting...",
          createdAt: 2000,
        },
      ],
      userMessage: "Why does the narrator mention it?",
    });
    const text = result.systemBlocks[0].text;
    expect(text).toContain("--- ACTIVE THREAD PASSAGE (inherited) ---");
    expect(text).toContain("a pall falling over the land");
    expect(text).toContain("epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)");
    expect(text).toContain("On dispersal");
    const content = result.messages[result.messages.length - 1].content as string;
    expect(content).toContain("No new passage attached; using most recent thread passage as anchor");
    expect(content).toContain("Why does the narrator mention it?");
  });

  it("when no passage on current turn and no excerpt in thread, no ACTIVE THREAD PASSAGE block (freeform)", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        { id: "m1", threadId: "t1", role: "user", content: "What is the book about?", createdAt: 1000 },
        { id: "m2", threadId: "t1", role: "assistant", content: "It's about...", createdAt: 2000 },
      ],
      userMessage: "Tell me more.",
    });
    // Block body only appears when we actually push an inherited passage
    expect(result.systemBlocks[0].text).not.toContain(
      "This turn has no new passage attached; the passage below is the most recent from the thread."
    );
    const content = result.messages[result.messages.length - 1].content as string;
    expect(content).toContain("(No passage is attached to this message.)");
  });

  it("when current turn has attached passage (pendingExcerpt), no inherited block (current passage is anchor)", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        {
          id: "m1",
          threadId: "t1",
          role: "user",
          content: "First question",
          createdAt: 1000,
          excerptText: "old excerpt",
          excerptCfi: "epubcfi(/6/4!/4/2/1:0)",
          excerptChapter: "Chapter 1",
        },
        { id: "m2", threadId: "t1", role: "assistant", content: "Reply", createdAt: 2000 },
      ],
      attachedHighlights: [],
      pendingExcerpt: {
        text: "new selected phrase",
        cfi: "epubcfi(/6/10!/4/2/1:0)",
        chapter: "Chapter 2",
      },
      userMessage: "Explain this.",
    });
    // Inherited block body only appears when we have no passage on current turn
    expect(result.systemBlocks[0].text).not.toContain(
      "This turn has no new passage attached; the passage below is the most recent from the thread."
    );
    const content = result.messages[result.messages.length - 1].content as string;
    expect(content).toContain("new selected phrase");
    expect(content).not.toContain("using most recent thread passage as anchor");
  });

  it("Sanatorium scenario: follow-up without new passage gets inherited anchor and anchor notice", () => {
    // Simulates: user attached "Sanatorium", asked "what is a sanatorium"; then follow-up "why does the narrator mention it you think?" with no new passage.
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        {
          id: "m1",
          threadId: "t1",
          role: "user",
          content: "what is a sanatorium",
          createdAt: 1000,
          excerptText: "Sanatorium",
          excerptCfi: "epubcfi(/6/4!/4/2/1:0)",
          excerptChapter: "Chapter 3",
        },
        {
          id: "m2",
          threadId: "t1",
          role: "assistant",
          content: "A sanatorium is a hospital for long-term illness, often in a rural setting.",
          createdAt: 2000,
        },
      ],
      userMessage: "why does the narrator mention it you think?",
    });
    const text = result.systemBlocks[0].text;
    expect(text).toContain("--- ACTIVE THREAD PASSAGE (inherited) ---");
    expect(text).toContain("Sanatorium");
    expect(text).toContain("epubcfi(/6/4!/4/2/1:0)");
    expect(text).toContain("Chapter 3");
    const content = result.messages[result.messages.length - 1].content as string;
    expect(content).toContain("No new passage attached; using most recent thread passage as anchor");
    expect(content).toContain("why does the narrator mention it you think?");
    // Model has anchor and instruction to use it; should not ask user to point to text (prompt-level verification).
    expect(text).toContain("Only ask the user to point to the text again when there is no active anchor");
  });

  it("freeform thread: first message with no passage has no inherited block and freeform marker", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [],
      userMessage: "What is this book about?",
    });
    expect(result.systemBlocks[0].text).not.toContain(
      "This turn has no new passage attached; the passage below is the most recent from the thread."
    );
    const content = result.messages[result.messages.length - 1].content as string;
    expect(content).toContain("(No passage is attached to this message.)");
    expect(content).toContain("What is this book about?");
  });

  it("inherited passage uses most recent user message with excerpt (skips assistant and older)", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        {
          id: "m1",
          threadId: "t1",
          role: "user",
          content: "First",
          createdAt: 1000,
          excerptText: "old passage",
          excerptCfi: "epubcfi(/6/4!/4/2/1:0)",
        },
        { id: "m2", threadId: "t1", role: "assistant", content: "Reply", createdAt: 2000 },
        {
          id: "m3",
          threadId: "t1",
          role: "user",
          content: "Why?",
          createdAt: 3000,
          excerptText: "most recent passage",
          excerptCfi: "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
          excerptChapter: "Later",
        },
        { id: "m4", threadId: "t1", role: "assistant", content: "Because...", createdAt: 4000 },
      ],
      userMessage: "What does he mean here?",
    });
    const text = result.systemBlocks[0].text;
    expect(text).toContain("--- ACTIVE THREAD PASSAGE (inherited) ---");
    expect(text).toContain("most recent passage");
    expect(text).toContain("epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)");
    expect(text).toContain("Later");
    expect(text).not.toContain("old passage");
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

  it("Phase 30 structured memory: injects --- MEMORY --- system block when memoryItems provided", () => {
    const result = assembleThreadContext({
      ...baseParams,
      memoryItems: [
        {
          id: "mi-1",
          content: "You tend to distrust narrators who over-justify.",
          type: "intellectual",
          scope: "global",
          confidence: 0.82,
          observationCount: 4,
          source: "compaction",
          createdAt: 0,
          lastReinforcedAt: 0,
          anchors: [],
        },
      ],
    });
    expect(result.systemBlocks.length).toBeGreaterThanOrEqual(2);
    const memBlock = result.systemBlocks.find((b) => b.text.startsWith("--- MEMORY ---\n"));
    expect(memBlock).toBeDefined();
    expect(memBlock!.text).toContain("implicitly by default");
    expect(memBlock!.text).toContain("type: intellectual");
    expect(memBlock!.text).toContain("scope: global");
    expect(memBlock!.text).toContain("usageMode: implicit");
    expect(memBlock!.text).toContain("content: You tend to distrust narrators who over-justify.");
    expect(result.messages).toHaveLength(1);
    const userTurn = result.messages[0];
    expect(userTurn.role).toBe("user");
    expect(userTurn.content as string).not.toContain("[MEMORY CONTEXT]");
  });

  it("Phase 30 structured memory: no MEMORY system block when memoryItems empty or undefined", () => {
    const result = assembleThreadContext(baseParams);
    expect(result.messages).toHaveLength(1);
    expect(result.systemBlocks.some((b) => b.text.startsWith("--- MEMORY ---\n"))).toBe(false);
    expect((result.messages[0].content as string)).not.toContain("[MEMORY CONTEXT]");
  });

  it("Phase 30 structured memory: first turn with memoryItems -> MEMORY system block only (no extra user message)", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [],
      memoryItems: [
        {
          id: "mi-1",
          content: "You prefer concise answers.",
          type: "preference",
          scope: "global",
          confidence: 0.8,
          observationCount: 2,
          source: "compaction",
          createdAt: 0,
          lastReinforcedAt: 0,
          anchors: [],
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    const memBlock = result.systemBlocks.find((b) => b.text.startsWith("--- MEMORY ---\n"));
    expect(memBlock?.text).toContain("You prefer concise answers.");
    expect(memBlock?.text).toContain("scope: global");
    expect(memBlock?.text).toContain("type: preference");
  });

  it("Phase 30 structured memory: sanitizes conversational phrasing before system injection", () => {
    const result = assembleThreadContext({
      ...baseParams,
      memoryItems: [
        {
          id: "mi-1",
          content:
            "You asked before about grounding abstract ideas. You prefer sensory, concrete examples when reading philosophy.",
          type: "preference",
          scope: "global",
          confidence: 0.85,
          observationCount: 3,
          source: "compaction",
          createdAt: 0,
          lastReinforcedAt: 0,
          anchors: [],
        },
      ],
    });
    const memBlock = result.systemBlocks.find((b) => b.text.startsWith("--- MEMORY ---\n"));
    expect(memBlock?.text).toMatch(/sensory, concrete examples/i);
    const contentLine = memBlock!.text.split("\n").find((l) => l.trimStart().startsWith("content:"));
    expect(contentLine).toBeDefined();
    expect(contentLine!.toLowerCase()).not.toContain("you asked before");
  });

  it("Phase 30.5: second turn without memoryItems -> memory block absent", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        { id: "m1", threadId: "t1", role: "user", content: "First question", createdAt: 0 },
        { id: "m2", threadId: "t1", role: "assistant", content: "First reply", createdAt: 0 },
      ],
      memoryItems: undefined,
      userMessage: "Second question",
    });
    const hasMemoryBlock = result.messages.some(
      (m) => typeof m.content === "string" && (m.content as string).includes("[MEMORY CONTEXT]")
    );
    expect(hasMemoryBlock).toBe(false);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("Phase 30.5: existing thread with prior messages -> no memory block reinjection", () => {
    const result = assembleThreadContext({
      ...baseParams,
      messages: [
        { id: "m1", threadId: "t1", role: "user", content: "Earlier", createdAt: 0 },
        { id: "m2", threadId: "t1", role: "assistant", content: "Reply", createdAt: 0 },
      ],
      memoryItems: undefined,
      userMessage: "Follow-up",
    });
    result.messages.forEach((m) => {
      if (typeof m.content === "string") {
        expect((m.content as string)).not.toContain("[MEMORY CONTEXT]");
      }
    });
  });

  describe("Phase 33 — context manifest draft", () => {
    it("returns manifestDraft with id, threadId, bookId, createdAt", () => {
      const result = assembleThreadContext({
        threadId: "t1",
        messages: [],
        attachedHighlights: [],
        userMessage: "What?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
      });
      expect(result.manifestDraft).toBeDefined();
      expect(result.manifestDraft.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(result.manifestDraft.threadId).toBe("t1");
      expect(result.manifestDraft.bookId).toBe("b1");
      expect(typeof result.manifestDraft.createdAt).toBe("number");
    });

    it("turnMode is passage_attached when current turn has passage (pendingExcerpt)", () => {
      const result = assembleThreadContext({
        threadId: "t1",
        messages: [],
        attachedHighlights: [],
        pendingExcerpt: {
          text: "selected",
          cfi: "epubcfi(/6/4!/4/2/1:0)",
          chapter: "Chapter 2",
        },
        userMessage: "Explain.",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
      });
      expect(result.manifestDraft.turnMode).toBe("passage_attached");
      expect(result.manifestDraft.activeAnchorSource).toBe("current");
      expect(result.manifestDraft.activeAnchorPresent).toBe(true);
    });

    it("turnMode is not passage_attached when only thread highlights (no pendingExcerpt)", () => {
      const result = assembleThreadContext({
        threadId: "t1",
        messages: [
          {
            id: "m1",
            threadId: "t1",
            role: "user",
            content: "First",
            createdAt: 1000,
            excerptText: "excerpt",
            excerptCfi: "epubcfi(/6/4!/4/2/1:0)",
            excerptChapter: "Ch 1",
          },
          { id: "m2", threadId: "t1", role: "assistant", content: "Reply", createdAt: 2000 },
        ],
        attachedHighlights: [
          {
            id: "h1",
            bookId: "b1",
            cfi: "epubcfi(/6/4!/4/2/1:0)",
            selectedText: "excerpt",
            color: "yellow",
            chapterLabel: "Ch 1",
            createdAt: 0,
          },
        ],
        userMessage: "Why?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
      });
      expect(result.manifestDraft.turnMode).toBe("inherited_anchor");
      expect(result.manifestDraft.activeAnchorSource).toBe("inherited");
    });

    it("turnMode is inherited_anchor when no passage but thread has excerpt", () => {
      const result = assembleThreadContext({
        threadId: "t1",
        messages: [
          {
            id: "m1",
            threadId: "t1",
            role: "user",
            content: "First",
            createdAt: 1000,
            excerptText: "excerpt",
            excerptCfi: "epubcfi(/6/4!/4/2/1:0)",
            excerptChapter: "Ch 1",
          },
          { id: "m2", threadId: "t1", role: "assistant", content: "Reply", createdAt: 2000 },
        ],
        attachedHighlights: [],
        userMessage: "Why?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
      });
      expect(result.manifestDraft.turnMode).toBe("inherited_anchor");
      expect(result.manifestDraft.activeAnchorSource).toBe("inherited");
      expect(result.manifestDraft.activeAnchorPresent).toBe(true);
    });

    it("turnMode is freeform when no passage and no inherited excerpt", () => {
      const result = assembleThreadContext({
        threadId: "t1",
        messages: [
          { id: "m1", threadId: "t1", role: "user", content: "What is the book about?", createdAt: 1000 },
          { id: "m2", threadId: "t1", role: "assistant", content: "It is about...", createdAt: 2000 },
        ],
        attachedHighlights: [],
        userMessage: "Tell me more.",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
      });
      expect(result.manifestDraft.turnMode).toBe("freeform");
      expect(result.manifestDraft.activeAnchorSource).toBe("none");
      expect(result.manifestDraft.activeAnchorPresent).toBe(false);
    });

    it("highlightsCount, historyMessageCount, memoryItemsCount are set", () => {
      const result = assembleThreadContext({
        threadId: "t1",
        messages: [
          { id: "m1", threadId: "t1", role: "user", content: "Q", createdAt: 0 },
          { id: "m2", threadId: "t1", role: "assistant", content: "A", createdAt: 0 },
        ],
        attachedHighlights: [
          { id: "h1", bookId: "b1", cfi: "cfi1", selectedText: "t", color: "yellow", createdAt: 0 },
        ],
        userMessage: "Follow-up",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        memoryItems: [
          {
            id: "mi-1",
            content: "You generally prefer short, direct answers when reading.",
            type: "preference",
            scope: "global",
            confidence: 0.5,
            observationCount: 1,
            source: "compaction",
            createdAt: 0,
            lastReinforcedAt: 0,
            anchors: [],
          },
        ],
      });
      expect(result.manifestDraft.highlightsCount).toBe(1);
      expect(result.manifestDraft.highlightsCfis).toEqual(["cfi1"]);
      expect(result.manifestDraft.historyMessageCount).toBe(2);
      expect(result.manifestDraft.memoryItemsCount).toBe(1);
    });
  });
});

describe("Phase 27 — askClaudeThread agentic loop", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("returns answer immediately when response has no toolCalls", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        answer: "The passage means X.",
        toolCalls: [],
        rawContent: [{ type: "text", text: "The passage means X." }],
        model: "claude-haiku-4-5-20251001",
      })
      .mockResolvedValueOnce(undefined); // db_save_manifest (fire-and-forget)

    const result = await askClaudeThread(
      {
        threadId: "t1",
        messages: [],
        attachedHighlights: [],
        userMessage: "What does this mean?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        getContextAroundCfi: () => ({
          sectionLabel: null,
          charsBefore: 0,
          charsAfter: 0,
          atSectionStart: false,
          atSectionEnd: false,
          text: "",
        }),
      },
      "test-api-key"
    );

    expect(result.answer).toBe("The passage means X.");
    expect(result.completedManifest).toBeDefined();
    expect(invoke).toHaveBeenCalledWith("ask_claude_thread_proxy", expect.anything());
    expect(invoke).toHaveBeenCalledWith("db_save_manifest", expect.anything());
  });

  it("calls getContextAroundCfi with new schema (cfi, direction, max_chars) and passes anchorText from pendingExcerpt", async () => {
    const getContextAroundCfi = vi.fn().mockReturnValue({
      sectionLabel: "Chapter 3",
      charsBefore: 500,
      charsAfter: 300,
      atSectionStart: false,
      atSectionEnd: false,
      text: "some context text",
    } satisfies GetContextResult);
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        answer: "",
        toolCalls: [
          {
            name: "get_context",
            id: "toolu_1",
            input: {
              cfi: "epubcfi(/6/4!/4/2)",
              direction: "before",
              max_chars: 3000,
            },
          },
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_context",
            input: {
              cfi: "epubcfi(/6/4!/4/2)",
              direction: "before",
              max_chars: 3000,
            },
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
      })
      .mockResolvedValueOnce(undefined); // db_save_manifest

    await askClaudeThread(
      {
        threadId: "t1",
        messages: [],
        attachedHighlights: [],
        pendingExcerpt: {
          text: "selected phrase",
          cfi: "epubcfi(/6/4!/4/2)",
          chapter: "Chapter 3",
        },
        userMessage: "What came before this?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        getContextAroundCfi,
      },
      "test-api-key"
    );

    expect(getContextAroundCfi).toHaveBeenCalledWith(
      "epubcfi(/6/4!/4/2)",
      "before",
      3000,
      "selected phrase"
    );
  });

  it("passes inherited excerptText as anchorText when no pendingExcerpt (non-highlight thread excerpt)", async () => {
    const getContextAroundCfi = vi.fn().mockReturnValue({
      sectionLabel: "On dispersal",
      charsBefore: 0,
      charsAfter: 200,
      atSectionStart: true,
      atSectionEnd: false,
      text: "leading text…",
    } satisfies GetContextResult);
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        answer: "",
        toolCalls: [
          {
            name: "get_context",
            id: "toolu_1",
            input: {
              cfi: "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
              direction: "from_section_start",
              max_chars: 2000,
            },
          },
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_context",
            input: {
              cfi: "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
              direction: "from_section_start",
              max_chars: 2000,
            },
          },
        ],
        model: "claude-haiku-4-5-20251001",
      })
      .mockResolvedValueOnce({
        answer: "Here is the answer.",
        toolCalls: [],
        rawContent: [{ type: "text", text: "Here is the answer." }],
        model: "claude-haiku-4-5-20251001",
      })
      .mockResolvedValueOnce(undefined);

    await askClaudeThread(
      {
        threadId: "t1",
        messages: [
          {
            id: "m1",
            threadId: "t1",
            role: "user",
            content: "Why does the narrator say this?",
            createdAt: 1000,
            excerptText: "a pall falling over the land",
            excerptCfi: "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
            excerptChapter: "On dispersal",
          },
          { id: "m2", threadId: "t1", role: "assistant", content: "Because…", createdAt: 2000 },
        ],
        attachedHighlights: [],
        userMessage: "What led up to this?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        getContextAroundCfi,
      },
      "test-api-key"
    );

    expect(getContextAroundCfi).toHaveBeenCalledWith(
      "epubcfi(/6/22!/4/2/2/14,/1:0,/3:100)",
      "from_section_start",
      2000,
      "a pall falling over the land"
    );
  });

  it("tool result is JSON-serialized GetContextResult with atSectionStart, atSectionEnd, charsBefore, charsAfter", async () => {
    const result: GetContextResult = {
      sectionLabel: "Chapter 1",
      charsBefore: 100,
      charsAfter: 2000,
      atSectionStart: true,
      atSectionEnd: false,
      text: "Very start of chapter…",
    };
    const getContextAroundCfi = vi.fn().mockReturnValue(result);
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        answer: "",
        toolCalls: [
          {
            name: "get_context",
            id: "toolu_1",
            input: { cfi: "epubcfi(/6/4!/4/2)", direction: "after", max_chars: 5000 },
          },
        ],
        rawContent: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_context",
            input: { cfi: "epubcfi(/6/4!/4/2)", direction: "after", max_chars: 5000 },
          },
        ],
        model: "claude-haiku-4-5-20251001",
      })
      .mockResolvedValueOnce({
        answer: "Done.",
        toolCalls: [],
        rawContent: [{ type: "text", text: "Done." }],
        model: "claude-haiku-4-5-20251001",
      })
      .mockResolvedValueOnce(undefined);

    await askClaudeThread(
      {
        threadId: "t1",
        messages: [],
        attachedHighlights: [],
        pendingExcerpt: { text: "anchor", cfi: "epubcfi(/6/4!/4/2)", chapter: "Ch 1" },
        userMessage: "What follows?",
        bookTitle: "Book",
        author: "Author",
        bookId: "b1",
        getContextAroundCfi,
      },
      "test-api-key"
    );

    expect(getContextAroundCfi).toHaveBeenCalledWith(
      "epubcfi(/6/4!/4/2)",
      "after",
      5000,
      "anchor"
    );
    const secondInvoke = vi.mocked(invoke).mock.calls[1];
    expect(secondInvoke[0]).toBe("ask_claude_thread_proxy");
    const req = (secondInvoke[1] as { request: { messages: Array<{ role: string; content: unknown }> } })
      .request;
    const userMsg = req.messages.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg).toBeDefined();
    const blocks = userMsg!.content as Array<{ type: string; content?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result");
    expect(toolResult?.content).toBeDefined();
    const parsed = JSON.parse(toolResult!.content!) as GetContextResult;
    expect(parsed.atSectionStart).toBe(true);
    expect(parsed.atSectionEnd).toBe(false);
    expect(parsed.charsBefore).toBe(100);
    expect(parsed.charsAfter).toBe(2000);
    expect(parsed.text).toBe("Very start of chapter…");
  });

  describe("Passage context prefetch", () => {
    it("auto-prefetches on pendingExcerpt turn before round 0 with before and 2000 chars", async () => {
      const leadUp = "Earlier the narrator had mentioned the sanatorium.";
      const getContextAroundCfi = vi.fn().mockReturnValue({
        sectionLabel: "Chapter 3",
        charsBefore: 500,
        charsAfter: 0,
        atSectionStart: false,
        atSectionEnd: false,
        text: leadUp,
      } satisfies GetContextResult);
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "A sanatorium is…",
          toolCalls: [],
          rawContent: [{ type: "text", text: "A sanatorium is…" }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: {
            text: "Sanatorium",
            cfi: "epubcfi(/6/4!/4/2/1:0)",
            chapter: "Chapter 3",
          },
          userMessage: "What is a sanatorium?",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
        },
        "test-api-key"
      );

      expect(getContextAroundCfi).toHaveBeenCalledWith(
        "epubcfi(/6/4!/4/2/1:0)",
        "before",
        2000,
        "Sanatorium"
      );
      const proxyCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === "ask_claude_thread_proxy");
      expect(proxyCall).toBeDefined();
      const systemBlocks = (proxyCall![1] as { request: { systemBlocks: Array<{ text: string }> } })
        .request.systemBlocks;
      const leadUpBlock = systemBlocks.find((b) =>
        b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---")
      );
      expect(leadUpBlock).toBeDefined();
      expect(leadUpBlock!.text).toContain(leadUp);
    });

    it("auto-prefetches for passage_only eval like non-eval turns", async () => {
      const leadUp = "Lead before anchor.";
      const getContextAroundCfi = vi.fn().mockReturnValue({
        sectionLabel: "Ch 1",
        charsBefore: 100,
        charsAfter: 0,
        atSectionStart: false,
        atSectionEnd: false,
        text: leadUp,
      } satisfies GetContextResult);
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "Eval answer.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Eval answer." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t-eval",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: { text: "Anchor bit", cfi: "epubcfi(/6/2!/4/8)", chapter: "Ch 1" },
          userMessage: "Who is speaking?",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
          evaluationToolPreset: "passage_only",
        },
        "test-api-key"
      );

      expect(getContextAroundCfi).toHaveBeenCalledWith(
        "epubcfi(/6/2!/4/8)",
        "before",
        2000,
        "Anchor bit"
      );
      const proxyCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === "ask_claude_thread_proxy");
      const systemBlocks = (proxyCall![1] as { request: { systemBlocks: Array<{ text: string }> } })
        .request.systemBlocks;
      const leadUpBlock = systemBlocks.find((b) =>
        b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---")
      );
      expect(leadUpBlock).toBeDefined();
      expect(leadUpBlock!.text).toContain(leadUp);
    });

    it("does not auto-prefetch for tools eval (passage_only only)", async () => {
      const getContextAroundCfi = vi.fn().mockReturnValue({
        sectionLabel: "Ch 1",
        charsBefore: 100,
        charsAfter: 0,
        atSectionStart: false,
        atSectionEnd: false,
        text: "Should not appear.",
      } satisfies GetContextResult);
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "Answer.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Answer." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t-tools-eval",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: { text: "excerpt", cfi: "epubcfi(/6/4!/4/2)", chapter: "Ch 1" },
          userMessage: "Explain.",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
          evaluationToolPreset: "tools",
        },
        "test-api-key"
      );

      expect(getContextAroundCfi).not.toHaveBeenCalled();
      const proxyCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === "ask_claude_thread_proxy");
      const systemBlocks = (proxyCall![1] as { request: { systemBlocks: Array<{ text: string }> } })
        .request.systemBlocks;
      expect(
        systemBlocks.some((b) => b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---"))
      ).toBe(false);
    });

    it("auto-prefetch does not call onContextFetched", async () => {
      const onContextFetched = vi.fn();
      const getContextAroundCfi = vi.fn().mockReturnValue({
        sectionLabel: "Ch 1",
        charsBefore: 100,
        charsAfter: 0,
        atSectionStart: false,
        atSectionEnd: false,
        text: "Lead-up text.",
      } satisfies GetContextResult);
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "Answer.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Answer." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: { text: "excerpt", cfi: "epubcfi(/6/4!/4/2)", chapter: "Ch 1" },
          userMessage: "Explain.",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
          onContextFetched,
        },
        "test-api-key"
      );

      expect(getContextAroundCfi).toHaveBeenCalled();
      expect(onContextFetched).not.toHaveBeenCalled();
    });

    it("explicit get_context tool call does call onContextFetched", async () => {
      const onContextFetched = vi.fn();
      const getContextAroundCfi = vi.fn().mockReturnValue({
        sectionLabel: "Ch 1",
        charsBefore: 50,
        charsAfter: 100,
        atSectionStart: false,
        atSectionEnd: false,
        text: "Fetched context from tool.",
      } satisfies GetContextResult);
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "",
          toolCalls: [
            {
              name: "get_context",
              id: "toolu_1",
              input: {
                cfi: "epubcfi(/6/4!/4/2)",
                direction: "before",
                max_chars: 2000,
              },
            },
          ],
          rawContent: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_context",
              input: {
                cfi: "epubcfi(/6/4!/4/2)",
                direction: "before",
                max_chars: 2000,
              },
            },
          ],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce({
          answer: "Done.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Done." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: { text: "excerpt", cfi: "epubcfi(/6/4!/4/2)", chapter: "Ch 1" },
          userMessage: "What came before?",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
          onContextFetched,
        },
        "test-api-key"
      );

      expect(onContextFetched).toHaveBeenCalledTimes(1);
      expect(onContextFetched).toHaveBeenCalledWith("Fetched context from tool.");
    });

    it("source-identification: fetch-then-answer flow yields correct source when lead-up does not name it", async () => {
      // Regression: "what essay is this from?" must not be answered from excerpt/lead-up alone.
      // Auto-prefetch returns lead-up that does not name the essay (Woolf case). Model calls get_context (after);
      // we return text that names "Thunder at Wembley"; model answers from that. Proves the desired path works.
      const getContextAroundCfi = vi.fn().mockImplementation((_cfi, direction) => ({
        sectionLabel: "Essays",
        charsBefore: 500,
        charsAfter: 800,
        atSectionStart: false,
        atSectionEnd: false,
        text:
          direction === "before"
            ? "The crowd had gathered. She reflected on the noise and the lights."
            : direction === "after"
              ? "This passage is from \"Thunder at Wembley\", first published in 1924."
              : "",
      } satisfies GetContextResult));
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "",
          toolCalls: [
            {
              name: "get_context",
              id: "toolu_1",
              input: {
                cfi: "epubcfi(/6/4!/4/2/1:0)",
                direction: "after",
                max_chars: 2000,
              },
            },
          ],
          rawContent: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_context",
              input: {
                cfi: "epubcfi(/6/4!/4/2/1:0)",
                direction: "after",
                max_chars: 2000,
              },
            },
          ],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce({
          answer: "This is from the essay Thunder at Wembley.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "This is from the essay Thunder at Wembley." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      const result = await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: {
            text: "a fragment of quoted prose",
            cfi: "epubcfi(/6/4!/4/2/1:0)",
            chapter: "Essays",
          },
          userMessage: "What essay is this from?",
          bookTitle: "The Essays",
          author: "Virginia Woolf",
          bookId: "b1",
          getContextAroundCfi,
        },
        "test-api-key"
      );

      expect(result.answer).toContain("Thunder at Wembley");
      const afterOrAroundCalls = getContextAroundCfi.mock.calls.filter(
        (c) => c[1] === "after" || c[1] === "around"
      );
      expect(afterOrAroundCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("no auto-prefetch when pendingExcerpt absent", async () => {
      const getContextAroundCfi = vi.fn();
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "Reply.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Reply." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          userMessage: "What does this mean?",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
        },
        "test-api-key"
      );

      expect(getContextAroundCfi).not.toHaveBeenCalled();
    });

    it("no lead-up block when prefetch returns empty text", async () => {
      const getContextAroundCfi = vi.fn().mockReturnValue({
        sectionLabel: null,
        charsBefore: 0,
        charsAfter: 0,
        atSectionStart: false,
        atSectionEnd: false,
        text: "",
      } satisfies GetContextResult);
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "Answer.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Answer." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: { text: "excerpt", cfi: "epubcfi(/6/4!/4/2)", chapter: "Ch 1" },
          userMessage: "Explain.",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
        },
        "test-api-key"
      );

      const proxyCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === "ask_claude_thread_proxy");
      const systemBlocks = (proxyCall![1] as { request: { systemBlocks: Array<{ text: string }> } })
        .request.systemBlocks;
      const hasLeadUp = systemBlocks.some((b) =>
        b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---")
      );
      expect(hasLeadUp).toBe(false);
    });

    it("prefetch failure is swallowed: turn still reaches model without lead-up block", async () => {
      const getContextAroundCfi = vi.fn().mockImplementation(() => {
        throw new Error("Resolver edge case / section not loaded");
      });
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          answer: "Answered from the excerpt alone.",
          toolCalls: [],
          rawContent: [{ type: "text", text: "Answered from the excerpt alone." }],
          model: "claude-haiku-4-5-20251001",
        })
        .mockResolvedValueOnce(undefined);

      const result = await askClaudeThread(
        {
          threadId: "t1",
          messages: [],
          attachedHighlights: [],
          pendingExcerpt: { text: "excerpt", cfi: "epubcfi(/6/4!/4/2)", chapter: "Ch 1" },
          userMessage: "What does this mean?",
          bookTitle: "Book",
          author: "Author",
          bookId: "b1",
          getContextAroundCfi,
        },
        "test-api-key"
      );

      expect(result.answer).toBe("Answered from the excerpt alone.");
      expect(getContextAroundCfi).toHaveBeenCalled();
      const proxyCall = vi.mocked(invoke).mock.calls.find((c) => c[0] === "ask_claude_thread_proxy");
      expect(proxyCall).toBeDefined();
      const systemBlocks = (proxyCall![1] as { request: { systemBlocks: Array<{ text: string }> } })
        .request.systemBlocks;
      const hasLeadUp = systemBlocks.some((b) =>
        b.text.includes("--- CURRENT TURN LEAD-UP CONTEXT ---")
      );
      expect(hasLeadUp).toBe(false);
    });
  });
});
