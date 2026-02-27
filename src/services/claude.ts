import { invoke } from "@tauri-apps/api/core";
import type { Highlight, ThreadMessage } from "@/types/book";
import type { SectionSummary } from "@/services/db";

export interface ClaudeRequest {
  selectedText: string;
  surroundingContext: string;
  bookTitle: string;
  author: string;
  userMessage?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ClaudeResponse {
  answer: string;
  model: string;
  usage?: {
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ThreadContextParams {
  threadId: string;
  messages: ThreadMessage[];
  attachedHighlights: Highlight[];
  userMessage: string;
  bookTitle: string;
  author: string;
  bookId: string;
  bookMemory?: string | null;
  readerProfile?: string | null;
  /** Session-only working context: last 1–2 get_context results, injected as a second system block for follow-up continuity. */
  workingContext?: string;
  bookSummary?: string | null;
  sectionSummaries?: SectionSummary[];
  scanStatus?: "none" | "in_progress" | "done";
  /** Inferred from scan: "essays" | "narrative" | "journal_entries" | "other" — used to simplify structure map for linear books. */
  bookStructureType?: string | null;
  /** Current reader position (pass currentTocHref) — used to annotate sections ahead of reader. */
  currentCfi?: string | null;
  onSuggestSmartScan?: () => void;
}

/** Message content: string for normal turns, array of blocks for tool_result turns. */
export type ThreadMessageContent = string | unknown[];

export interface AssembledThreadRequest {
  systemBlocks: Array<{ text: string; cacheControl?: "ephemeral" }>;
  messages: Array<{ role: "user" | "assistant"; content: ThreadMessageContent }>;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEEP_ANALYSIS_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROMPT = "Explain this passage in context.";

/** Stable rules (behavior, style) — cached by the API. Rarely changes. */
const STABLE_SYSTEM_RULES = [
  "Answer questions about the text concisely and accurately. Ground your answers in the book's content.",
  "Never assume the gender of the author, use they/them.",
  "Do not summarize the entire book unless asked. Be conversational, not academic.",
  "You need not ask questions all the time to the user, use questions sparingly.",
].join("\n");

/** Session-specific (book, author) — not cached. */
function buildSessionSystemPrompt(bookTitle: string, author: string): string {
  return `You are a reading assistant embedded in an ebook reader. The user is reading "${bookTitle}" by "${author}".`;
}

function chooseModelAndMaxTokens(userMessage: string): { model: string; maxTokens: number } {
  const query = userMessage.toLowerCase();
  const asksDeepAnalysis =
    query.includes("deep analysis") ||
    query.includes("analyze deeply") ||
    query.includes("in depth") ||
    query.includes("in-depth");
  return asksDeepAnalysis
    ? { model: DEEP_ANALYSIS_MODEL, maxTokens: 1200 }
    : { model: DEFAULT_MODEL, maxTokens: 600 };
}

function getApiKey(): string {
  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "Missing Anthropic API key. Add VITE_ANTHROPIC_API_KEY to your .env file and restart the dev server."
    );
  }
  return key;
}

export async function askClaude({
  selectedText,
  surroundingContext,
  bookTitle,
  author,
  userMessage,
  conversationHistory = [],
}: ClaudeRequest): Promise<ClaudeResponse> {
  const apiKey = getApiKey();
  const prompt = (userMessage ?? "").trim() || DEFAULT_PROMPT;
  const { model, maxTokens } = chooseModelAndMaxTokens(prompt);

  const data = await invoke<{
    answer: string;
    model: string;
    usage?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
  }>("ask_claude_proxy", {
    request: {
      apiKey,
      model,
      systemPromptStable: STABLE_SYSTEM_RULES,
      systemPromptSession: buildSessionSystemPrompt(bookTitle, author),
      surroundingContext,
      selectedText,
      userMessage: prompt,
      conversationHistory,
      maxTokens,
    },
  });
  const answer = data.answer ?? "";
  if (data.usage) {
    console.log("[Claude usage]", data.usage);
  }

  return {
    answer,
    model: data.model ?? model,
    usage: data.usage,
  };
}

const TITLE_SYSTEM_PROMPT =
  "You are a titling assistant. Output only a short phrase (4-6 words) that could serve as a discussion title. No explanation, no questions, no punctuation at the end. Do not ask for more context.";

/** Generate a thread title. Uses a minimal proxy (no passage/context blocks) so the model doesn't expect book context. */
export async function generateThreadTitle(topicOrQuestion: string, apiKey: string): Promise<string> {
  const userMessage =
    topicOrQuestion.trim().length > 0
      ? `Topic or first question: "${topicOrQuestion.slice(0, 300)}". Output only the title.`
      : "Output only a generic title like 'Reading discussion' or 'Notes'.";
  const data = await invoke<{ answer: string }>("ask_claude_simple_proxy", {
    request: {
      apiKey,
      model: DEFAULT_MODEL,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userMessage,
    },
  });
  return (data.answer ?? "").trim();
}

/** Normalize href for comparison: strip fragment, leading ./, lowercase. */
function normalizeHrefForMatch(href: string): string {
  const withoutFragment = href.split("#")[0].trim();
  const withoutLeadingDot = withoutFragment.replace(/^\.\//, "").trim();
  return withoutLeadingDot.toLowerCase();
}

/** Returns the spine index for the reader's current position by matching tocHref (or cfi) against section summaries. */
function currentSpineIndexForCfi(
  cfi: string | null | undefined,
  summaries: Array<{ spineHref: string; spineIndex: number }>
): number {
  if (!cfi || summaries.length === 0) return 0;
  // EPUB CFI (epubcfi(...)) cannot be matched to spine href; only tocHref can
  const isEpubCfi = typeof cfi === "string" && cfi.trim().toLowerCase().startsWith("epubcfi(");
  if (isEpubCfi) return 0;
  const normalized = normalizeHrefForMatch(cfi);
  if (!normalized) return 0;
  // Exact match after normalization
  let idx = summaries.findIndex((s) => normalizeHrefForMatch(s.spineHref) === normalized);
  if (idx >= 0) return summaries[idx].spineIndex;
  // Basename match (e.g. "chapter05.xhtml" vs "OEBPS/chapter05.xhtml")
  const base = normalized.split("/").pop() ?? "";
  if (base) {
    idx = summaries.findIndex((s) => {
      const sNorm = normalizeHrefForMatch(s.spineHref);
      return sNorm === base || sNorm.endsWith("/" + base);
    });
    if (idx >= 0) return summaries[idx].spineIndex;
  }
  return 0;
}

/** Assemble system blocks and messages for thread-aware Claude request. */
export function assembleThreadContext(params: ThreadContextParams): AssembledThreadRequest {
  const {
    bookTitle,
    author,
    readerProfile,
    bookMemory,
    attachedHighlights,
    messages,
    userMessage,
  } = params;

  const systemParts: string[] = [];
  // --- IDENTITY ---
  systemParts.push(
    `--- IDENTITY ---\nYou are Marginalia, a reading companion for "${bookTitle}" by ${author}.`
  );
  // --- READER PROFILE ---
  if (readerProfile?.trim()) {
    systemParts.push(`--- READER PROFILE ---\n${readerProfile.trim()}`);
  }
  // --- READING HISTORY (this book) ---
  if (bookMemory?.trim()) {
    const trimmed = bookMemory.trim();
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount <= 500) {
      systemParts.push(`--- READING HISTORY (this book) ---\n${trimmed}`);
    } else {
      const entries = trimmed.split("\n## ");
      const recent = entries.slice(-3);
      systemParts.push(
        `--- READING HISTORY (this book) ---\n## ${recent.join("\n## ")}`
      );
      systemParts.push(
        `You have ${Math.max(0, entries.length - 3)} prior journal entries for this book.`
      );
    }
  }
  // --- BOOK OVERVIEW ---
  if (params.bookSummary?.trim()) {
    systemParts.push(`--- BOOK OVERVIEW ---\n${params.bookSummary.trim()}`);
  }
  // --- SECTION INDEX --- (single collapsed list: spine_href | section name | spine N | type | tokens | radii | [ahead])
  if (
    params.scanStatus === "done" &&
    params.sectionSummaries &&
    params.sectionSummaries.length > 0
  ) {
    const currentSpineIndex = currentSpineIndexForCfi(
      params.currentCfi,
      params.sectionSummaries
    );
    const hrefCol = (s: { spineHref: string; spineIndex: number }) =>
      (s.spineHref ?? "").trim() || `spine-${s.spineIndex}`;
    const sectionIndexLines = params.sectionSummaries.map((s) => {
      const isAhead = s.spineIndex > currentSpineIndex;
      const typeTag =
        s.structureType === "prefatory" || s.structureType === "reference"
          ? s.structureType
          : s.structureType === "journal_entries" && s.entryCount != null
            ? `${s.structureType} · ${s.entryCount} entries`
            : `${s.structureType} · ~${s.estimatedTokens.toLocaleString()} tokens`;
      const sectionName = s.tocLabel ?? hrefCol(s);
      const radii = `snippet=${s.radiusGuide.snippet} section=${s.radiusGuide.section} full=${s.radiusGuide.full}`;
      const ahead = isAhead ? " [ahead]" : "";
      return `  ${hrefCol(s)} | "${sectionName}" · spine ${s.spineIndex} · ${typeTag} · ${radii}${ahead}`;
    });
    systemParts.push(
      `--- SECTION INDEX ---\n` +
        `Use spine_href (first column) with get_section_summary or get_section_text. Summaries are not inlined; call the tool when needed.\n` +
        `Reader's current position maps to spine index ${currentSpineIndex}; sections with [ahead] are past the reader.\n\n` +
        sectionIndexLines.join("\n") +
        `\n\nFor get_context: use radii above as char_radius (snippet / section / full). Only use [ahead] sections if the reader asks about content ahead; flag spoilers.`
    );
  }
  // --- TOOLS & CONTEXT ---
  systemParts.push(
    "--- TOOLS & CONTEXT ---\n" +
    "The reader never sees tool results. When you call get_context, get_section_summary, or get_section_text, the returned content is for you only. " +
    "You must quote or paraphrase whatever is relevant in your reply so the reader gets the answer; do not refer to 'what I pulled', 'as the section shows', or assume they can see the fetched text.\n" +
    "Your default state is the selected passage and the reader's question. " +
    "Do not assume knowledge of the broader book beyond what you are given. " +
    "You have a tool — get_context — to fetch surrounding text if the question genuinely needs it. " +
      "Use it when the reader asks about 'the previous section', 'earlier in the chapter', 'what came before', or how the passage relates to nearby text: call get_context (with a larger char_radius to include prior content) rather than asking the user to supply or paste text. " +
      "When you need more context, call get_context in this turn — do not only say you will fetch text or that you need to see more; actually invoke the tool so the next response can use the result. " +
      "Use the tool sparingly for other questions; most can be answered from the passage alone." +
      "And even if you have more context, don't assume the reader has read past the excerpt passed by the user. You don't want spoiling the book unless explicit in the question. Perhaps hint at the possible explanation like 'this will be clearer as you read further' especially if the passed passage is at the start of the section being read."
  );
  // --- RESPONSE RULES ---
  systemParts.push(
    "--- RESPONSE RULES ---\n" +
    "Respond as a thoughtful reading companion, not an assistant. " +
    "Never narrate your own actions or observations about the interface: do not say 'I can see you've highlighted', 'I notice the passage', 'you've selected', or any variant. " +
    "Do not narrate using the book structure or tools: do not say 'Looking at the book structure', 'Based on the section summary', 'I checked the contents', 'spine 6', 'spine 7', or expose token counts or spine indices. Use that information to answer; do not describe that you used it. " +
    "Do not open with a restatement of what the reader asked or what they highlighted. " +
    "Begin directly with the substance of your response. " +
    "Be concise. Favour depth over comprehensiveness — one sharp observation beats five adequate ones. " +
    "Do not use bullet points unless the content is genuinely list-like. Prefer prose."
  );
  systemParts.push(
    "Do not treat follow-up questions as corrections or pushback. " +
    "If the reader asks why, or questions something you said, engage with the question directly — " +
    "do not apologise, do not say you misread or misspoke unless you genuinely did, " +
    "do not walk back your previous answer unless the reader has explicitly said it was wrong. " +
    "A reader asking 'why?' is curious, not disputing." +
    "You are allowed to be confident in your readings. " +
"Uncertainty should come from the text being genuinely ambiguous, not from the reader asking questions."
  );

  // --- CLOSURE SIGNALS ---
  systemParts.push(
    "--- CLOSURE SIGNALS ---\n" +
    "When the reader says \"its fine,\" \"no worries,\" \"never mind,\" \"skip it,\" or similar closure signals — stop. " +
    "Do not acknowledge the signal, do not summarize what you learned, do not express gratitude or wrap up the topic. " +
    "Just stop and wait for the next thing. Treat closure as a full stop, not permission to land the plane."
  );

  // --- CITATIONS ---
  systemParts.push(
    "--- CITATIONS ---\n" +
    "When your answer includes a specific quoted passage from the book, put the citation comment immediately BEFORE the quote. " +
    "The reader will see the quote; the comment is invisible. One comment per quote. Do not add a citation block at the end.\n" +
    "Use a short lead-in then the comment then the verbatim quote, e.g. \"The author writes: \" then the comment then \" the exact words from the book.\" " +
    "CRITICAL — the visible quote must be a CONTINUOUS VERBATIM substring from the book. No '...' or paraphrasing. " +
    "If long, quote only the most distinctive phrase (under 240 chars).\n" +
    "Format: lead-in (e.g. \"X says:\" or \"It goes: \") then <!--cite:{\"anchorBefore\":\"...\",\"anchorAfter\":\"...\",\"spineHint\":null}--> then the quote. Do not repeat the quote inside the comment."
  );

  const highlightedSections =
    attachedHighlights.length > 0
      ? attachedHighlights
          .map((h) => `[${h.chapterLabel ?? "Chapter"}] | CFI: ${h.cfi}\n${h.selectedText}`)
          .join("\n\n---\n\n")
      : "(No highlights in this thread)";

  const historyMessages: AssembledThreadRequest["messages"] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const currentTurn: AssembledThreadRequest["messages"][0] = {
    role: "user" as const,
    content:
      attachedHighlights.length > 0
        ? `${highlightedSections}\n\n${userMessage}`
        : userMessage,
  };

  const systemBlocks: AssembledThreadRequest["systemBlocks"] = [
    { text: systemParts.join("\n\n"), cacheControl: "ephemeral" },
  ];
  if (params.workingContext?.trim()) {
    systemBlocks.push({
      text: `Current working context (fetched this session):\n\n${params.workingContext.trim()}`,
      cacheControl: "ephemeral",
    });
  }

  return {
    systemBlocks,
    messages: [...historyMessages, currentTurn],
  };
}

const GET_CONTEXT_TOOL = {
  name: "get_context",
  description:
    "Retrieve text from the book around a specific position. Only use this to expand around the reader's current passage: pass the EPUB CFI that appears in the user's message (the highlight), and char_radius. Use when the reader asks about 'the previous section', 'earlier in the chapter', or how the passage relates to surrounding text — use a larger char_radius to include prior content. Do NOT pass a spine href or path (e.g. OEBPS/chapter08.html): get_context only accepts an EPUB CFI and cannot fetch by section. For another section's content use get_section_summary (you get the summary only; there is no tool to fetch full text of a different section).",
  input_schema: {
    type: "object",
    properties: {
      cfi: {
        type: "string",
        description:
          "An EPUB CFI string (e.g. epubcfi(/6/4!/4/2/1:0)) — must be exactly the CFI from the user's message (the highlighted passage). Do not pass a spine href or file path.",
      },
      char_radius: {
        type: "number",
        description:
          "Characters to include before and after the anchor. 2000 for local context, 8000 for a section, 20000 for a long chapter. Max 40000.",
      },
    },
    required: ["cfi", "char_radius"],
  },
} as const;

const GET_SECTION_SUMMARY_TOOL = {
  name: "get_section_summary",
  description:
    "Retrieve the AI-generated summary for a specific section (by spine_href). Returns the summary only. Use for thematic questions or to decide which section to fetch full text from with get_section_text.",
  input_schema: {
    type: "object",
    properties: {
      spine_href: {
        type: "string",
        description:
          "Pass the spine_href exactly as it appears at the start of each line in the section index (before the first ' | '), e.g. OEBPS/chapter04.html or xhtml/9_Chapters.xhtml. Do not pass the label or 'spine N' — only the href.",
      },
    },
    required: ["spine_href"],
  },
} as const;

const GET_SECTION_TEXT_TOOL = {
  name: "get_section_text",
  description:
    "Retrieve the full text of a section by spine_href. Use this when the reader asks for pertinent lines, exact quotes, or specific passages from a section they have not reached — call with the spine_href from the section index. Returns the raw text of that section so you can quote and discuss specific lines.",
  input_schema: {
    type: "object",
    properties: {
      spine_href: {
        type: "string",
        description:
          "The spine_href from the section index (first column before ' | '). Use exactly as shown — e.g. OEBPS/chapter08.html or spine-6 when the index shows spine-N (EPUBs with no path).",
      },
    },
    required: ["spine_href"],
  },
} as const;

const SUGGEST_SMART_SCAN_TOOL = {
  name: "suggest_smart_scan",
  description:
    "Call this when you have tried to answer a question and recognise that understanding the book's broader structure would meaningfully improve your response. Call it at most once. This surfaces a prompt to the user — it does not run the scan itself.",
  input_schema: { type: "object", properties: {}, required: [] },
} as const;

export type AskClaudeThreadParams = ThreadContextParams & {
  getContextAroundCfi: (cfi: string, charRadius: number) => string;
  /** When provided, enables get_section_text so the model can fetch full text of a section by spine_href and quote lines. */
  getSectionTextByHref?: (spineHref: string) => Promise<string>;
  /** Called when the model invokes a tool (e.g. get_context) so the UI can show a fetch indicator. */
  onToolCall?: (toolName: string) => void;
  /** Called when get_context returns; App uses this to update session-only working context (ref) for the next turn. */
  onContextFetched?: (text: string) => void;
};

const MAX_TOOL_ROUNDS = 3;

/** Format system blocks + messages as a single string for debugging (full prompt sent to Claude). */
function formatThreadPromptForLog(
  systemBlocks: Array<{ text: string; cacheControl?: string }>,
  messages: Array<{ role: string; content: ThreadMessageContent }>
): string {
  const parts: string[] = [];
  parts.push("=== SYSTEM ===");
  for (let i = 0; i < systemBlocks.length; i++) {
    parts.push(`--- system block ${i + 1} ---`);
    parts.push(systemBlocks[i].text);
  }
  parts.push("=== MESSAGES ===");
  for (let j = 0; j < messages.length; j++) {
    const m = messages[j];
    parts.push(`--- message ${j + 1} [${m.role}] ---`);
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as { type?: string; text?: string; [k: string]: unknown };
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        } else {
          parts.push(JSON.stringify(block));
        }
      }
    } else {
      parts.push(String(m.content));
    }
  }
  return parts.join("\n");
}

/** Returns true when the user's question likely requires broader book context. */
function isContextSeekingQuery(msg: string): boolean {
  const q = msg.toLowerCase();
  return (
    // Explicit context requests
    q.includes("previous section") ||
    q.includes("earlier in") ||
    q.includes("what came before") ||
    q.includes("rest of the essay") ||
    q.includes("rest of the chapter") ||
    q.includes("what follows") ||
    q.includes("next section") ||
    q.includes("surrounding text") ||
    q.includes("more context") ||
    q.includes("full passage") ||
    q.includes("before this") ||
    q.includes("after this") ||
    // Relational / comparative questions that need surrounding narrative
    q.includes("relate") ||
    q.includes("connect") ||
    q.includes("contrast") ||
    q.includes("how does this") ||
    q.includes("what is the context") ||
    q.includes("leading up to") ||
    q.includes("what happens") ||
    q.includes("how does it fit")
  );
}

export async function askClaudeThread(
  params: AskClaudeThreadParams,
  apiKey: string
): Promise<ClaudeResponse> {
  const assembled = assembleThreadContext(params);
  const model = chooseModelAndMaxTokens(params.userMessage).model;
  let messages: AssembledThreadRequest["messages"] = assembled.messages;
  /**
   * Force tool use on round 0 only when the user's message explicitly asks for
   * surrounding/relational context (e.g. "how does this relate to the rest of the essay").
   * Do not force for simple clarifications (e.g. "what does X mean") — the model can
   * answer from the passage. Subsequent rounds always use "auto".
   */
  const forceToolChoice = isContextSeekingQuery(params.userMessage);
  let suggestSmartScanUsed = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Build dynamic tools for this round
    const tools: unknown[] = [GET_CONTEXT_TOOL];
    if (params.scanStatus === "done" && (params.sectionSummaries?.length ?? 0) > 0) {
      tools.push(GET_SECTION_SUMMARY_TOOL);
      if (params.getSectionTextByHref) {
        tools.push(GET_SECTION_TEXT_TOOL);
      }
    }
    if (params.scanStatus === "none" && !suggestSmartScanUsed) {
      tools.push(SUGGEST_SMART_SCAN_TOOL);
    }

    const roundRequest = {
      apiKey,
      model,
      systemBlocks: assembled.systemBlocks.map((b) => ({
        text: b.text,
        cacheControl: b.cacheControl ?? undefined,
      })),
      messages,
      tools,
      toolChoice: forceToolChoice && round === 0 ? "any" : "auto",
    };
    const fullPromptRound = formatThreadPromptForLog(roundRequest.systemBlocks, messages);
    console.log("[Claude thread] full prompt (round %d):\n%s", round, fullPromptRound);

    const data = await invoke<{
      answer: string;
      toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>;
      rawContent: unknown[];
      model: string;
      usage?: ClaudeResponse["usage"];
    }>("ask_claude_thread_proxy", {
      request: roundRequest,
    });

    const hasToolCalls = (data.toolCalls?.length ?? 0) > 0;
    console.log("[Claude thread] round=%d toolChoice=%s tools=%o", round, forceToolChoice && round === 0 ? "any" : "auto", tools.map((t: unknown) => (t as { name: string }).name));
    console.log("[Claude thread] answer=%o toolCalls=%o", data.answer, data.toolCalls);
    if (data.toolCalls?.length) {
      for (const call of data.toolCalls) {
        console.log("[Claude thread] tool_call name=%s input=%o", call.name, call.input);
      }
    }
    if (data.usage) {
      console.log("[Claude thread usage]", data.usage);
    }

    if (!hasToolCalls) {
      return {
        answer: data.answer ?? "",
        model: data.model ?? model,
        usage: data.usage,
      };
    }

    for (const call of data.toolCalls!) {
      if (call.name !== "suggest_smart_scan") {
        params.onToolCall?.(call.name);
      }
    }

    const toolResults = await Promise.all(
      data.toolCalls!.map(async (call) => {
        if (call.name === "get_context") {
          const { cfi, char_radius } = call.input as { cfi: string; char_radius?: number };
          const isEpubCfi =
            typeof cfi === "string" && cfi.trim().toLowerCase().startsWith("epubcfi(");
          if (!isEpubCfi) {
            const content =
              "(get_context requires an EPUB CFI from the user's passage, e.g. epubcfi(/6/4!/4/2/1:0). You passed a spine href or path — get_context cannot fetch by section. For another section use get_section_summary or get_section_text.)";
            return { tool_use_id: call.id, content };
          }
          const result = params.getContextAroundCfi(
            cfi,
            Math.min(char_radius ?? 4000, 40000)
          );
          const content = result || "(No text found at this position)";
          if (result?.trim()) params.onContextFetched?.(result);
          return { tool_use_id: call.id, content };
        }
        if (call.name === "get_section_summary") {
          const { spine_href } = call.input as { spine_href: string };
          const spineIndexMatch = spine_href.trim().match(/^spine-(\d+)$/);
          const found = params.sectionSummaries?.find((s) =>
            spineIndexMatch
              ? s.spineIndex === parseInt(spineIndexMatch[1], 10)
              : (s.spineHref ?? "").trim() === spine_href.trim() ||
                  (s.spineHref ?? "").trim() === spine_href.split("#")[0].trim()
          );
          const content = found
            ? found.summary
            : `(No summary found for section "${spine_href}")`;
          return { tool_use_id: call.id, content };
        }
        if (call.name === "get_section_text") {
          const { spine_href } = call.input as { spine_href: string };
          const text =
            params.getSectionTextByHref != null
              ? await params.getSectionTextByHref(spine_href)
              : "";
          const content =
            text?.trim() || `(Could not load full text for section "${spine_href}". Section may not exist or failed to load.)`;
          return { tool_use_id: call.id, content };
        }
        if (call.name === "suggest_smart_scan") {
          suggestSmartScanUsed = true;
          params.onSuggestSmartScan?.();
          return {
            tool_use_id: call.id,
            content: "(Smart Scan suggestion surfaced to user)",
          };
        }
        return { tool_use_id: call.id, content: "(Unknown tool)" };
      })
    );

    messages = [
      ...messages,
      { role: "assistant" as const, content: data.rawContent },
      {
        role: "user" as const,
        content: toolResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      },
    ];
  }

  const finalRequest = {
    apiKey,
    model,
    systemBlocks: assembled.systemBlocks.map((b) => ({
      text: b.text,
      cacheControl: b.cacheControl ?? undefined,
    })),
    messages,
  };
  const fullPromptFinal = formatThreadPromptForLog(finalRequest.systemBlocks, messages);
  console.log("[Claude thread] full prompt (final, after tool rounds):\n%s", fullPromptFinal);

  const finalData = await invoke<{
    answer: string;
    model: string;
    usage?: ClaudeResponse["usage"];
  }>("ask_claude_thread_proxy", {
    request: finalRequest,
  });
  return {
    answer: finalData.answer ?? "",
    model: finalData.model ?? model,
    usage: finalData.usage,
  };
}
