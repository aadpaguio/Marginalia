import { invoke } from "@tauri-apps/api/core";
import type { Highlight, MemoryItem, ThreadMessage, ThreadToolEvent, WebCitation } from "@/types/book";
import type {
  ContextManifest,
  ContextAnchorSource,
  ContextTurnMode,
} from "@/types/contextManifest";
import type { SectionSummary } from "@/services/db";
import { memoryGetItemsForBook, memoryGetItemsGlobal, memoryGetItemsGlobalForQuery } from "@/services/db";
import {
  formatMemoryItemsSystemBlock,
  promptReadyMemoryItem,
  rankMemoryItemsForPrompt,
  shouldIncludeMemoryItemForQuery,
  type PromptReadyMemoryItem,
} from "@/services/memoryPrompt";

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
  /** Phase 33: context manifest for the completed turn (set when persist is triggered). */
  completedManifest?: ContextManifest;
  /** Web citations attached to assistant messages. */
  webCitations?: WebCitation[];
  /** Compact sequential tool/system events for this assistant turn. */
  toolEvents?: ThreadToolEvent[];
}

/** Hybrid evaluation ablations (see EVALUATION_PLAN.md). */
export type EvaluationToolPreset = "passage_only" | "tools" | "smart_scan_tools";

export interface ThreadContextParams {
  threadId: string;
  messages: ThreadMessage[];
  attachedHighlights: Highlight[];
  /** Selected passage attached for this turn only (e.g. Add to thread without creating highlight). */
  pendingExcerpt?: {
    text: string;
    cfi: string;
    chapter?: string | null;
  };
  userMessage: string;
  bookTitle: string;
  author: string;
  bookId: string;
  bookMemory?: string | null;
  readerProfile?: string | null;
  /** Session-only working context: last 1–2 get_context results, injected as a second system block for follow-up continuity. */
  workingContext?: string;
  /** Turn-scoped auto-prefetched lead-up text (before first API call). Not sent through onContextFetched; not part of workingContext. */
  prefetchedLeadUpContext?: string;
  /**
   * Hybrid evaluation ablations: restricts tools and what is injected into the system prompt
   * so passage-only / tools-only / Smart Scan runs are reproducible.
   * Passage-only still runs the same auto-prefetch of text before the anchor as non-eval turns (not a tool call).
   */
  evaluationToolPreset?: EvaluationToolPreset;
  bookSummary?: string | null;
  sectionSummaries?: SectionSummary[];
  scanStatus?: "none" | "in_progress" | "done";
  /** Inferred from scan: "essays" | "narrative" | "journal_entries" | "other" — used to simplify structure map for linear books. */
  bookStructureType?: string | null;
  /** Current reader position (pass currentTocHref) — used to annotate sections ahead of reader. */
  currentCfi?: string | null;
  onSuggestSmartScan?: () => void;
  /** Phase 30.5: relevant memory items to inject as prefill user block. */
  memoryItems?: MemoryItem[];
}

/** Message content: string for normal turns, array of blocks for tool_result turns. */
export type ThreadMessageContent = string | unknown[];

export interface AssembledThreadRequest {
  systemBlocks: Array<{ text: string; cacheControl?: "ephemeral" }>;
  messages: Array<{ role: "user" | "assistant"; content: ThreadMessageContent }>;
  manifestDraft: Omit<ContextManifest, "toolCallsMade" | "finalAnswerChars">;
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
  "When web_search is available, use it for: author biography, publication history, or interviews; historical events, people, or places referenced in the text; literary criticism, reviews, or scholarly discussion of the book; factual claims that benefit from verification; current events or recent developments related to themes in the book. Do not search for information that is clearly available in the book text itself.",
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

/** Load relevant memory items: book by recency, global by semantic relevance with recency fallback. */
export async function loadRelevantMemoryItems(
  bookId: string,
  userMessage: string
): Promise<MemoryItem[]> {
  const topBook = (await memoryGetItemsForBook(bookId))
    .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
    .slice(0, 4);
  let topGlobal: MemoryItem[] = [];
  try {
    topGlobal = await memoryGetItemsGlobalForQuery(userMessage, 4);
  } catch {
    topGlobal = [];
  }
  if (topGlobal.length === 0) {
    topGlobal = (await memoryGetItemsGlobal())
      .sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt)
      .slice(0, 4);
  }
  const seen = new Set<string>();
  const merged: MemoryItem[] = [];
  for (const i of topBook) {
    if (merged.length >= 10) break;
    if (!seen.has(i.id)) {
      seen.add(i.id);
      merged.push(i);
    }
  }
  for (const i of topGlobal) {
    if (merged.length >= 10) break;
    if (!seen.has(i.id)) {
      seen.add(i.id);
      merged.push(i);
    }
  }
  const ranked = rankMemoryItemsForPrompt(merged);
  const filtered = ranked.filter((i) => shouldIncludeMemoryItemForQuery(i, userMessage, bookId));
  return filtered.slice(0, 10);
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

/** Phase 30.2: Get current chapter label from CFI + section summaries (for chapter-proximate injection). */
function getCurrentChapterLabel(
  currentCfi: string | null | undefined,
  sectionSummaries: Array<{ spineHref: string; spineIndex: number; tocLabel?: string | null }> | undefined
): string | null {
  if (!sectionSummaries?.length) return null;
  const sorted = [...sectionSummaries].sort((a, b) => a.spineIndex - b.spineIndex);
  const spineIndex = currentSpineIndexForCfi(currentCfi, sorted);
  const section = sorted.find((s) => s.spineIndex === spineIndex);
  const label = section?.tocLabel?.trim();
  return label || null;
}

const CHAPTERS_LINE_REGEX = /^chapters:\s*(.+)$/m;

/** Phase 30.2: Build reading history block; when current chapter is known, add chapter-proximate entries not already in recent. */
function buildReadingHistoryBlock(
  bookMemory: string,
  currentChapterLabel: string | null
): string {
  const trimmed = bookMemory.trim();
  if (!trimmed) return "";
  if (!currentChapterLabel) return trimmed;

  const sections = trimmed.split(/\n(?=## )/);
  let summaryBlock = "";
  const recentBodies: string[] = [];
  const otherWithChapters: Array<{ body: string }> = [];
  let inRecentThreads = false;
  let recentCount = 0;

  for (const s of sections) {
    const titleMatch = s.match(/^## (.+?)(?:\n|$)/);
    const title = titleMatch?.[1]?.trim() ?? "";
    if (title === "Reading Summary") {
      summaryBlock = s;
      inRecentThreads = false;
      continue;
    }
    if (title === "Recent Threads") {
      inRecentThreads = true;
      recentCount = 0;
      if (summaryBlock) summaryBlock = `${summaryBlock}\n\n${s}`;
      else summaryBlock = s;
      continue;
    }
    const chaptersMatch = s.match(CHAPTERS_LINE_REGEX);
    const chaptersLine = chaptersMatch?.[1]?.trim() ?? "";
    const isProximate =
      chaptersLine &&
      (chaptersLine.includes(currentChapterLabel) ||
        currentChapterLabel.includes(chaptersLine));
    if (inRecentThreads && recentCount < 2) {
      recentBodies.push(s);
      recentCount++;
    } else if (isProximate && chaptersLine) {
      otherWithChapters.push({ body: s });
    }
  }

  const recentSet = new Set(recentBodies);
  const proximateOnly = otherWithChapters.filter(({ body }) => !recentSet.has(body));
  if (proximateOnly.length === 0) return trimmed;
  const proximateBlock = proximateOnly.map(({ body }) => body).join("\n\n");
  const recentBlock = recentBodies.length > 0 ? recentBodies.join("\n\n") : "";
  return summaryBlock
    ? recentBlock
      ? `${summaryBlock}\n\n${recentBlock}\n\n---\n\n## Chapter-proximate entries\n${proximateBlock}`
      : `${summaryBlock}\n\n---\n\n## Chapter-proximate entries\n${proximateBlock}`
    : `${trimmed}\n\n---\n\n## Chapter-proximate entries\n${proximateBlock}`;
}

const MAX_INHERITED_EXCERPT_CHARS = 600;

/** Most recent user message in the thread that has excerpt metadata; used for passage continuity when current turn has no attached passage. */
function getInheritedThreadPassage(
  messages: ThreadMessage[]
): { excerptText: string; excerptCfi: string; excerptChapter?: string | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.excerptText?.trim();
    const cfi = m.excerptCfi?.trim();
    if (text && cfi) {
      return {
        excerptText: text,
        excerptCfi: cfi,
        excerptChapter: m.excerptChapter ?? undefined,
      };
    }
  }
  return null;
}

/** Assemble system blocks and messages for thread-aware Claude request. */
export function assembleThreadContext(params: ThreadContextParams): AssembledThreadRequest {
  const {
    bookTitle,
    author,
    readerProfile,
    bookMemory,
    attachedHighlights,
    pendingExcerpt,
    messages,
    userMessage,
  } = params;

  const evalPreset = params.evaluationToolPreset;
  const evalHidesScanAndOverview =
    evalPreset === "passage_only" || evalPreset === "tools";
  const passageOnlyRetrievalPatterns =
    "--- RETRIEVAL PATTERNS ---\n" +
    "- Close reading: answer from the attached passage and, when present, CURRENT TURN LEAD-UP CONTEXT. No retrieval tools.\n" +
    "- Spoiler boundary: do not assume the reader has read beyond the excerpt.";
  const toolsOnlyRetrievalPatterns =
    "--- RETRIEVAL PATTERNS ---\n" +
    "- Close reading: answer from the passage when it already contains the answer. No tool needed.\n" +
    "- Local expansion: use get_context for neighboring text (before / after / around / from_section_start) when the question needs immediate surroundings.\n" +
    "- Spoiler boundary: do not assume the reader has read past the excerpt.\n" +
    "Treat these as heuristics, not rigid pipelines. Start with the lightest strategy that fits the question. Escalate only when needed.";
  const fullRetrievalPatterns =
    "--- RETRIEVAL PATTERNS ---\n" +
    "- Close reading: answer from the passage when it already contains the answer. No tool needed.\n" +
    "- Local expansion: use get_context for neighboring text (before / after / around / from_section_start).\n" +
    "- Orient then decide: call get_section_summary on the current section or a candidate section and read that summary before loading full section text. Do not call get_section_text without consulting a section summary first for that spine_href unless the reader explicitly asks for a specific passage or names an identified section. Prefer get_context when you only need anchor-adjacent wording instead of the whole section.\n" +
    "- Cross-section: use the section index to pick 1-2 candidate sections, check summaries first, then fetch full text only for the best match.\n" +
    "- Spoiler boundary: if answering would require content ahead of the reader's current position, say so and ask before fetching.\n" +
    "Treat these as heuristics, not rigid pipelines. Start with the lightest strategy that fits the question. Escalate only when needed.";

  const systemParts: string[] = [];
  // --- IDENTITY ---
  systemParts.push(
    `--- IDENTITY ---\nYou are Marginalia, a reading companion for "${bookTitle}" by ${author}.`
  );
  // --- READER PROFILE --- (always on: identity slot)
  systemParts.push(
    `--- READER PROFILE ---\n${readerProfile?.trim() || "(No reader profile yet.)"}`
  );
  // --- READING HISTORY (this book) --- (Phase 30.1: full; 30.2: chapter-proximate when known)
  let injectedBookMemoryChars = 0;
  if (bookMemory?.trim()) {
    const currentChapterLabel = getCurrentChapterLabel(
      params.currentCfi,
      params.sectionSummaries
    );
    const historyBlock = buildReadingHistoryBlock(bookMemory.trim(), currentChapterLabel);
    if (historyBlock) {
      injectedBookMemoryChars = historyBlock.length;
      systemParts.push(`--- READING HISTORY (this book) ---\n${historyBlock}`);
    }
  }
  // --- BOOK OVERVIEW ---
  if (params.bookSummary?.trim() && !evalHidesScanAndOverview) {
    systemParts.push(`--- BOOK OVERVIEW ---\n${params.bookSummary.trim()}`);
  }
  // --- SECTION INDEX --- (single collapsed list: spine_href | section name | spine N | type | tokens | radii | [ahead])
  if (
    !evalHidesScanAndOverview &&
    params.scanStatus === "done" &&
    params.sectionSummaries &&
    params.sectionSummaries.length > 0
  ) {
    const sortedSummaries = [...params.sectionSummaries].sort(
      (a, b) => a.spineIndex - b.spineIndex
    );
    const currentSpineIndex = currentSpineIndexForCfi(
      params.currentCfi,
      sortedSummaries
    );
    const hrefCol = (s: { spineHref: string; spineIndex: number }) =>
      (s.spineHref ?? "").trim() || `spine-${s.spineIndex}`;
    const sectionIndexLines = sortedSummaries.map((s) => {
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
      `The section index is ordered by spine index. ` +
        `Use spine_href (first column) with get_section_summary or get_section_text. Summaries are not inlined; call the tool when needed.\n` +
        `Reader's current position maps to spine index ${currentSpineIndex}; sections with [ahead] are past the reader.\n\n` +
        sectionIndexLines.join("\n") +
        `\n\nTreat [ahead] sections as spoiler-sensitive. Only use them if the reader asks about content ahead or gives permission to look forward.`
    );
  }
  // --- TOOLS & CONTEXT ---
  if (evalPreset === "passage_only") {
    systemParts.push(
      "--- CONTEXT (EVALUATION RUN) ---\n" +
        "This is a controlled evaluation run. You have no retrieval tools: do not use get_context, section summaries, or section text. " +
        "Answer using the passage attached to this message, the reader profile slot above, and — when present — the separate system block titled CURRENT TURN LEAD-UP CONTEXT " +
        "(text immediately before the anchor on this turn only; not carried to later turns). " +
        "Use that lead-up only to ground attribution, identification, or continuity the excerpt alone does not spell out; do not infer beyond what those two sources state. " +
        "Do not rely on book-wide structure, section index, or book overview — those are withheld for this condition.\n" +
        "Spoilers: Do not assume the reader has read past the excerpt.\n" +
        passageOnlyRetrievalPatterns
    );
  } else if (evalPreset === "tools") {
    systemParts.push(
      "--- TOOLS & CONTEXT (EVALUATION RUN) ---\n" +
        "The reader only ever sees your final message. They do not see tool calls, tool output, or any text you fetched.\n" +
        "You have exactly one retrieval tool: get_context (CFI + direction + max_chars). There is no section index or get_section_summary / get_section_text in this condition.\n" +
        "When to use get_context: when the question needs text around the reader's passage anchor. Pass the EPUB CFI from the passage or ACTIVE THREAD PASSAGE block, direction (before / after / around / from_section_start), and max_chars (snippet ~2000, section ~8000, full ~20000).\n" +
        "Spoilers: Do not assume the reader has read past the excerpt.\n" +
        toolsOnlyRetrievalPatterns
    );
  } else {
    systemParts.push(
      "--- TOOLS & CONTEXT ---\n" +
        "The reader only ever sees your final message. They do not see tool calls, tool output, or any text you fetched. So: never imply they can see it. Do not say 'as you can see from the context', 'what I retrieved shows', 'the passage I pulled', 'in the text I fetched', or similar. Answer as if the relevant content were already in front of you — quote or paraphrase it in your reply; that is the only way the reader gets the information.\n" +
        "Two normal turn types: (1) When a passage is attached to the message, you have that passage and the reader's question — use it as your default evidence base. (2) When no passage is attached but an ACTIVE THREAD PASSAGE (inherited) block is present below, this turn inherits the most recent thread passage — use it as the default anchor and its CFI for get_context when needed. (3) When no passage is attached and there is no active thread passage, this is a freeform thread question: you have only the reader's question. Only ask the user to point to the text again when there is no active anchor (no passage on this message and no ACTIVE THREAD PASSAGE block). Do not assume the reader has read beyond what is in front of them.\n" +
        fullRetrievalPatterns +
        "\n" +
        "When to use tools:\n" +
        "- get_context (CFI + direction + max_chars): Use when the question needs text around the reader's current passage. Pass the EPUB CFI and direction: use 'from_section_start' when you need what led up to the anchor from the start of the chapter/section; 'before' for immediate lead-up; 'after' for what follows; 'around' for local context. Use max_chars (snippet ~2000, section ~8000, full ~20000). The tool returns atSectionStart, atSectionEnd, charsBefore, charsAfter so you can reason about position (e.g. 'there may not be much prior context yet'). Use it in this turn if you need it; no need to ask first.\n" +
        "Attribution and source-identification: Do not answer attribution questions (e.g. 'what essay is this from?', 'who is speaking?', 'which chapter/section?') by inference or prior knowledge. You may only state a source, speaker, or title if it is explicitly stated in the attached passage or in the CURRENT TURN LEAD-UP CONTEXT block. If the attached passage and CURRENT TURN LEAD-UP CONTEXT together do not explicitly name the source, speaker, or essay, you must call get_context before answering — do not guess. For source-attribution in quoted or critical prose, when the lead-up (before) context does not resolve the attribution, call get_context with direction 'around' or 'after' to look for the title or speaker; then answer only from what the fetched text explicitly states.\n" +
        "- get_section_summary (spine_href): Use to get the summary of a section by its spine_href (from the section index). Helps with thematic questions or deciding if you need that section's full text.\n" +
        "- get_section_text (spine_href): Use when the reader wants exact quotes or specific lines from a section they have not reached. Pass the spine_href from the section index.\n" +
        "- get_past_thread (thread_id): Use when the --- MEMORY --- block lists a thread: line for an item and you need the archived conversation behind that memory.\n" +
        "Spoilers: Do not assume the reader has read past the excerpt. If the answer would spoil later content and they did not ask for it, hint instead (e.g. 'this becomes clearer as you read further').\n" +
        "Broader scope: If answering would require content from sections the reader has not reached (e.g. get_section_summary or get_section_text for later sections) or would spoil later material, prefer to say so and ask before fetching or summarising that content."
    );
  }
  // --- RESPONSE RULES ---
  systemParts.push(
    "--- RESPONSE RULES ---\n" +
    "Don't overexplain unless asked further by the user.\n" +
    "Match response length and scope to the user's question. Start from the smallest scope that honestly answers the question. Definitional or factual questions (e.g. 'what is X?', 'briefly, what's a sanatorium?') should usually get one sentence, or two at most; thematic or interpretive questions may get a paragraph. Do not expand from definition into thematic analysis unless the user asks for it.\n" +
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
    "When your answer includes a quoted passage from the book, put the citation comment immediately before the quote. " +
    "Format: <!--cite:{\"anchorBefore\":\"...\",\"anchorAfter\":\"...\"}--> then the quote wrapped in double quotes. " +
    "Do not repeat the same quoted passage elsewhere in plain text. One comment per quote."
  );

  const dedupedHighlights = [...attachedHighlights];
  if (pendingExcerpt?.text?.trim()) {
    const excerptText = pendingExcerpt.text.trim();
    const alreadyIncluded = dedupedHighlights.some(
      (h) => h.selectedText.trim() === excerptText && (h.cfi ?? "") === (pendingExcerpt.cfi ?? "")
    );
    if (!alreadyIncluded) {
      dedupedHighlights.push({
        id: "__pending_excerpt__",
        bookId: params.bookId,
        cfi: pendingExcerpt.cfi,
        selectedText: excerptText,
        color: "yellow",
        chapterLabel: pendingExcerpt.chapter ?? undefined,
        createdAt: 0,
      });
    }
  }

  const highlightedSections =
    dedupedHighlights.length > 0
      ? dedupedHighlights
          .map((h) => `[${h.chapterLabel ?? "Chapter"}] | CFI: ${h.cfi}\n${h.selectedText}`)
          .join("\n\n---\n\n")
      : "(No highlights in this thread)";

  const historyMessages: AssembledThreadRequest["messages"] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  // Per-turn: "passage attached to this message" = user attached for this send (pendingExcerpt), not all thread highlights
  const hasPassage = !!(pendingExcerpt?.text?.trim());
  const inherited =
    !hasPassage && messages.length > 0 ? getInheritedThreadPassage(messages) : null;
  if (inherited) {
    const excerptPreview =
      inherited.excerptText.length > MAX_INHERITED_EXCERPT_CHARS
        ? inherited.excerptText.slice(0, MAX_INHERITED_EXCERPT_CHARS - 1) + "…"
        : inherited.excerptText;
    systemParts.push(
      "--- ACTIVE THREAD PASSAGE (inherited) ---\n" +
        "This turn has no new passage attached; the passage below is the most recent from the thread. Use it as the default referent for follow-up questions (e.g. \"why does the narrator mention it?\") and use its CFI for get_context when you need nearby text.\n\n" +
        (inherited.excerptChapter ? `[${inherited.excerptChapter}]\n` : "") +
        `CFI: ${inherited.excerptCfi}\n\n${excerptPreview}`
    );
  }
  const currentTurn: AssembledThreadRequest["messages"][0] = {
    role: "user" as const,
    content: hasPassage
      ? `${highlightedSections}\n\n${userMessage}`
      : inherited
        ? `(No new passage attached; using most recent thread passage as anchor.)\n\n${userMessage}`
        : `(No passage is attached to this message.)\n\n${userMessage}`,
  };

  const memoryReady: PromptReadyMemoryItem[] = [];
  let memoryCharBudget = 0;
  if (params.memoryItems?.length && !evalPreset) {
    for (const raw of params.memoryItems) {
      if (memoryReady.length >= 10) break;
      const pr = promptReadyMemoryItem(raw);
      if (!pr) continue;
      const entryLen =
        pr.contentForPrompt.length + pr.item.type.length + pr.scope.length + (pr.usageMode?.length ?? 0) + 96;
      if (memoryCharBudget + entryLen > 4800) break;
      memoryReady.push(pr);
      memoryCharBudget += entryLen;
    }
  }
  const memoryInstructions =
    "Use these memory items implicitly by default: let them shape tone, depth, and examples without announcing that they come from stored memory.\n" +
    "Do not say \"you asked before\", \"as you said earlier\", \"in a previous discussion\", or similar unless the reader is clearly revisiting that thread and a brief callback is genuinely natural and materially helpful.\n" +
    "Treat global preference and reading-identity items as background guidance — not as dialogue to quote or attribute.\n" +
    "Treat book- and passage-scoped items as contextual hints about this book, not as quoted prior chat.";
  const memoryBlockBody =
    memoryReady.length > 0 ? `${memoryInstructions}\n\n${formatMemoryItemsSystemBlock(memoryReady)}` : "";

  const systemBlocks: AssembledThreadRequest["systemBlocks"] = [
    { text: systemParts.join("\n\n"), cacheControl: "ephemeral" },
  ];
  if (memoryBlockBody) {
    systemBlocks.push({
      text: `--- MEMORY ---\n${memoryBlockBody}`,
      cacheControl: "ephemeral",
    });
  }
  if (params.prefetchedLeadUpContext?.trim()) {
    systemBlocks.push({
      text: `--- CURRENT TURN LEAD-UP CONTEXT ---\nText immediately before the reader's attached passage (this turn only). Use it to ground attribution or identification answers; it is not carried to later turns.\n\n${params.prefetchedLeadUpContext.trim()}`,
      cacheControl: "ephemeral",
    });
  }
  if (params.workingContext?.trim() && !evalPreset) {
    systemBlocks.push({
      text: `Current working context (fetched this session):\n\n${params.workingContext.trim()}`,
      cacheControl: "ephemeral",
    });
  }

  const systemPromptChars = systemBlocks.reduce((s, b) => s + b.text.length, 0);
  // Reader profile block is always injected (real or placeholder); record actual assembled text length
  const readerProfileText = readerProfile?.trim() || "(No reader profile yet.)";
  const turnMode: ContextTurnMode = hasPassage
    ? "passage_attached"
    : inherited
      ? "inherited_anchor"
      : "freeform";
  const activeAnchorSource: ContextAnchorSource = hasPassage
    ? "current"
    : inherited
      ? "inherited"
      : "none";
  const activeAnchorCfi = hasPassage
    ? (pendingExcerpt?.cfi ?? dedupedHighlights[0]?.cfi) ?? null
    : inherited?.excerptCfi ?? null;
  const activeAnchorChapter = hasPassage
    ? (pendingExcerpt?.chapter ?? dedupedHighlights[0]?.chapterLabel) ?? null
    : inherited?.excerptChapter ?? null;

  function messageContentChars(content: ThreadMessageContent): number {
    if (typeof content === "string") return content.length;
    if (!Array.isArray(content)) return 0;
    return (content as Array<{ text?: string }>).reduce(
      (s, b) => s + (typeof b?.text === "string" ? b.text.length : 0),
      0
    );
  }
  const allMessages = [...historyMessages, currentTurn];
  const messagesChars = allMessages.reduce(
    (s, m) => s + messageContentChars(m.content),
    0
  );
  const totalChars = systemPromptChars + messagesChars;
  const estimatedInputTokens = Math.ceil(totalChars / 4);

  const manifestDraft: Omit<ContextManifest, "toolCallsMade" | "finalAnswerChars"> = {
    id: crypto.randomUUID(),
    threadId: params.threadId,
    bookId: params.bookId,
    createdAt: Date.now(),
    turnMode,
    activeAnchorPresent: hasPassage || !!inherited,
    activeAnchorSource,
    activeAnchorCfi: activeAnchorCfi ?? undefined,
    activeAnchorChapter: activeAnchorChapter ?? undefined,
    systemPromptChars,
    readerProfileIncluded: true,
    readerProfileChars: readerProfileText.length,
    bookMemoryIncluded: injectedBookMemoryChars > 0,
    bookMemoryChars: injectedBookMemoryChars > 0 ? injectedBookMemoryChars : undefined,
    bookOverviewIncluded: !!(params.bookSummary?.trim()),
    highlightsCount: dedupedHighlights.length,
    highlightsCfis: dedupedHighlights.map((h) => h.cfi ?? ""),
    historyMessageCount: messages.length,
    memoryItemsCount: memoryReady.length,
    estimatedInputTokens,
    toolsAvailable: [], // filled in askClaudeThread
    smartScanStatus: params.scanStatus ?? undefined,
  };

  return {
    systemBlocks,
    messages: allMessages,
    manifestDraft,
  };
}

const GET_CONTEXT_TOOL = {
  name: "get_context",
  description:
    "Retrieve neighboring text around the reader's passage anchor. If the passage already answers the question, no tool is needed. Pass the EPUB CFI from the user's message or ACTIVE THREAD PASSAGE (inherited), plus direction and max_chars. Use 'from_section_start' when you need what led up to the anchor from the start of the chapter/section; 'before' for immediate lead-up; 'after' for what follows; 'around' for local context on both sides. The tool returns sectionLabel, charsBefore, charsAfter, atSectionStart, atSectionEnd, and text — use these to reason about position (e.g. 'this is early in the chapter'). Do NOT pass a spine href: for another section use get_section_summary or get_section_text.",
  input_schema: {
    type: "object",
    properties: {
      cfi: {
        type: "string",
        description:
          "An EPUB CFI string (e.g. epubcfi(/6/4!/4/2/1:0)) — from the user's message (the highlighted passage) or from the ACTIVE THREAD PASSAGE (inherited) block when present. Do not pass a spine href or file path.",
      },
      direction: {
        type: "string",
        enum: ["before", "after", "around", "from_section_start"],
        description:
          "Where to fetch text relative to the anchor: 'from_section_start' = from start of section up to anchor (capped by max_chars); 'before' = immediate text before anchor; 'after' = text after anchor; 'around' = both sides.",
      },
      max_chars: {
        type: "number",
        description:
          "Maximum characters to return. Snippet ~2000, section ~8000, full chapter ~20000. Max 40000.",
      },
    },
    required: ["cfi", "direction", "max_chars"],
  },
} as const;

const GET_SECTION_SUMMARY_TOOL = {
  name: "get_section_summary",
  description:
    "Retrieve the AI-generated summary for a specific section (by spine_href). Returns the summary only. Use this to orient within one or two candidate sections before deciding whether you need get_context or get_section_text.",
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
    "Retrieve the full text of a section by spine_href. Default: call get_section_summary for that spine_href first and read it before fetching full text, unless the reader explicitly asks for lines from a named or clearly identified section. Use this when you need quotes or line-level evidence after orienting — pass the spine_href from the section index. Returns the raw text of that section so you can quote and discuss specific lines.",
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

const GET_PAST_THREAD_TOOL = {
  name: "get_past_thread",
  description:
    "Fetch the cleaned archived user/assistant exchange for a prior thread by thread_id. Use this when the --- MEMORY --- block includes a thread: field on an item and you need richer context from that archived discussion.",
  input_schema: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        description:
          "Thread id from a memory item's thread: line in the --- MEMORY --- block. Returns a clean user/assistant transcript with tool scaffolding removed.",
      },
    },
    required: ["thread_id"],
  },
} as const;

/** Direction for get_context: where to fetch text relative to the anchor. */
export type GetContextDirection = "before" | "after" | "around" | "from_section_start";

/** Structured result from get_context so the model knows anchor position and retrieval bounds. */
export interface GetContextResult {
  sectionLabel?: string | null;
  charsBefore: number;
  charsAfter: number;
  atSectionStart: boolean;
  atSectionEnd: boolean;
  text: string;
  /** True when the anchor could not be resolved (e.g. section not loaded or no anchor text for fallback). */
  anchorUnresolved?: boolean;
}

const SUGGEST_SMART_SCAN_TOOL = {
  name: "suggest_smart_scan",
  description:
    "Call this when you have tried to answer a question and recognise that understanding the book's broader structure would meaningfully improve your response. Call it at most once. This surfaces a prompt to the user — it does not run the scan itself.",
  input_schema: { type: "object", properties: {}, required: [] },
} as const;

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
} as const;

const REQUEST_WEB_SEARCH_TOOL = {
  name: "request_web_search",
  description:
    "Ask user permission before searching the web. Call this first with the exact query you want to run. Wait for tool_result before any web search.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Exact web search query to ask user approval for.",
      },
    },
    required: ["query"],
  },
} as const;

export type AskClaudeThreadParams = ThreadContextParams & {
  getContextAroundCfi: (
    cfi: string,
    direction: GetContextDirection,
    maxChars: number,
    anchorText?: string
  ) => GetContextResult;
  /** When provided, enables get_section_text so the model can fetch full text of a section by spine_href and quote lines. */
  getSectionTextByHref?: (spineHref: string) => Promise<string>;
  /** Returns a cleaned archived thread exchange by thread id. */
  getPastThreadMessages?: (threadId: string) => Promise<string>;
  /** Called when the model emits a sequential tool/system event for timeline rendering. */
  onToolEvent?: (event: ThreadToolEvent) => void;
  /** Called when get_context returns; App uses this to update session-only working context (ref) for the next turn. */
  onContextFetched?: (text: string) => void;
  /** Per-thread permission scope for web search (reset on new threads). */
  webSearchPermissionScope?: "ask" | "allow_thread";
  /** Called when Claude requests a web search query and UI must ask for permission. */
  requestWebSearchPermission?: (
    query: string
  ) => Promise<"allow_once" | "allow_thread" | "deny">;
};

const MAX_TOOL_ROUNDS = 3;

type ClaudeThreadProxyRoundData = {
  answer: string;
  toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>;
  rawContent: unknown[];
  model: string;
  usage?: ClaudeResponse["usage"];
  stopReason?: string;
  webSearchRequests?: number;
};

/** Characters to fetch before the anchor when auto-prefetching lead-up for passage-attached turns. */
const PREFETCH_LEAD_UP_CHARS = 2000;

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

/** Extract deduplicated web citations from Anthropic rawContent text blocks with `citations` arrays. */
function extractWebCitations(rawContent: unknown[]): WebCitation[] {
  const seen = new Set<string>();
  const citations: WebCitation[] = [];
  for (const block of rawContent ?? []) {
    const b = block as { type?: string; citations?: Array<{ type?: string; url?: string; title?: string; cited_text?: string }> };
    if (b.type !== "text" || !Array.isArray(b.citations)) continue;
    for (const c of b.citations) {
      if (c.type !== "web_search_result_location" || !c.url) continue;
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      citations.push({
        url: c.url,
        title: c.title ?? c.url,
        citedText: c.cited_text,
      });
    }
  }
  return citations;
}

function extractWebSearchQueries(rawContent: unknown[]): string[] {
  const queries: string[] = [];
  for (const block of rawContent ?? []) {
    const b = block as { type?: string; name?: string; input?: { query?: unknown } };
    if (b.type !== "server_tool_use" || b.name !== "web_search") continue;
    const query = typeof b.input?.query === "string" ? b.input.query.trim() : "";
    if (!query) continue;
    queries.push(query);
  }
  return queries;
}

function extractWebSearchResultLabels(rawContent: unknown[]): string[] {
  const labels: string[] = [];
  for (const block of rawContent ?? []) {
    const b = block as {
      type?: string;
      content?: unknown;
    };
    if (b.type !== "web_search_tool_result") continue;
    if (!Array.isArray(b.content)) {
      const err = (b.content as { type?: string; error_code?: string }) ?? {};
      if (err.type === "web_search_tool_result_error") {
        labels.push(`Web search error: ${err.error_code ?? "unknown_error"}.`);
      }
      continue;
    }
    labels.push(`Web search returned ${b.content.length} result${b.content.length === 1 ? "" : "s"}.`);
  }
  return labels;
}

/** Anthropic tool list for one round (evaluation presets vs production). */
function buildThreadToolList(
  params: AskClaudeThreadParams,
  suggestSmartScanUsed: boolean,
  webSearchMode: "request_only" | "enabled",
  webSearchMaxUses?: number
): unknown[] {
  const preset = params.evaluationToolPreset;
  if (preset === "passage_only") {
    return [];
  }
  if (preset === "tools") {
    return [GET_CONTEXT_TOOL];
  }
  if (preset === "smart_scan_tools") {
    const tools: unknown[] = [GET_CONTEXT_TOOL];
    if (params.getPastThreadMessages) {
      tools.push(GET_PAST_THREAD_TOOL);
    }
    if (params.scanStatus === "done" && (params.sectionSummaries?.length ?? 0) > 0) {
      tools.push(GET_SECTION_SUMMARY_TOOL);
      if (params.getSectionTextByHref) {
        tools.push(GET_SECTION_TEXT_TOOL);
      }
    }
    if (params.scanStatus === "none" && !suggestSmartScanUsed) {
      tools.push(SUGGEST_SMART_SCAN_TOOL);
    }
    if (webSearchMode === "enabled") {
      tools.push({ ...WEB_SEARCH_TOOL, max_uses: webSearchMaxUses ?? WEB_SEARCH_TOOL.max_uses });
    } else {
      tools.push(REQUEST_WEB_SEARCH_TOOL);
    }
    return tools;
  }
  const tools: unknown[] = [GET_CONTEXT_TOOL];
  if (params.getPastThreadMessages) {
    tools.push(GET_PAST_THREAD_TOOL);
  }
  if (params.scanStatus === "done" && (params.sectionSummaries?.length ?? 0) > 0) {
    tools.push(GET_SECTION_SUMMARY_TOOL);
    if (params.getSectionTextByHref) {
      tools.push(GET_SECTION_TEXT_TOOL);
    }
  }
  if (params.scanStatus === "none" && !suggestSmartScanUsed) {
    tools.push(SUGGEST_SMART_SCAN_TOOL);
  }
  if (webSearchMode === "enabled") {
    tools.push({ ...WEB_SEARCH_TOOL, max_uses: webSearchMaxUses ?? WEB_SEARCH_TOOL.max_uses });
  } else {
    tools.push(REQUEST_WEB_SEARCH_TOOL);
  }
  return tools;
}

export async function askClaudeThread(
  params: AskClaudeThreadParams,
  apiKey: string
): Promise<ClaudeResponse> {
  // One-time auto-prefetch for current-turn attached passage only (before first API call). Not sent through onContextFetched.
  // Best-effort: if prefetch throws (e.g. resolver edge case), continue without a lead-up block so the turn still reaches the model.
  // Skipped for tools / smart_scan_tools eval (model must use get_context). Kept for passage_only so lead-up matches production turns.
  let prefetchedLeadUpContext: string | undefined;
  if (
    (!params.evaluationToolPreset || params.evaluationToolPreset === "passage_only") &&
    params.pendingExcerpt?.text?.trim() &&
    params.pendingExcerpt?.cfi?.trim()
  ) {
    try {
      const result = params.getContextAroundCfi(
        params.pendingExcerpt.cfi.trim(),
        "before",
        PREFETCH_LEAD_UP_CHARS,
        params.pendingExcerpt.text.trim()
      );
      if (result.text?.trim()) {
        prefetchedLeadUpContext = result.text.trim();
      }
    } catch {
      // Degrade to no lead-up block; turn proceeds normally.
    }
  }
  const assembled = assembleThreadContext({
    ...params,
    prefetchedLeadUpContext,
  });
  const model = chooseModelAndMaxTokens(params.userMessage).model;
  let messages: AssembledThreadRequest["messages"] = assembled.messages;
  const turnToolEvents: ThreadToolEvent[] = [];
  const emitToolEvent = (event: ThreadToolEvent) => {
    turnToolEvents.push(event);
    params.onToolEvent?.(event);
  };
  const toolCallLog: Array<{
    tool: string;
    round: number;
    inputSummary: string;
    toolUseId: string;
    input: Record<string, unknown>;
    output?: unknown;
    error?: string;
    durationMs?: number;
  }> = [];

  /**
   * Force tool use on round 0 only when the user's message explicitly asks for
   * surrounding/relational context (e.g. "how does this relate to the rest of the essay").
   * Do not force for simple clarifications (e.g. "what does X mean") — the model can
   * answer from the passage. Subsequent rounds always use "auto".
   */
  const forceToolChoice =
    !params.evaluationToolPreset && isContextSeekingQuery(params.userMessage);
  let suggestSmartScanUsed = false;
  let totalWebSearchRequests = 0;
  let webSearchPermissionScope = params.webSearchPermissionScope ?? "ask";
  let allowSingleWebSearch = false;

  // Round-0 tool list for manifest (what options the model had when it started)
  const toolsAvailable = buildThreadToolList(
    params,
    false,
    webSearchPermissionScope === "allow_thread" ? "enabled" : "request_only"
  ).map(
    (t) => (t as { name: string }).name
  );

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Build dynamic tools for this round
    const tools = buildThreadToolList(
      params,
      suggestSmartScanUsed,
      webSearchPermissionScope === "allow_thread" || allowSingleWebSearch ? "enabled" : "request_only",
      allowSingleWebSearch ? 1 : undefined
    );

    let pauseTurnSteps = 0;
    let data: ClaudeThreadProxyRoundData;
    // Inner loop: `pause_turn` is for server-side web search; must not consume `MAX_TOOL_ROUNDS`.
    while (true) {
      const roundRequest = {
        apiKey,
        model,
        systemBlocks: assembled.systemBlocks.map((b) => ({
          text: b.text,
          cacheControl: b.cacheControl ?? undefined,
        })),
        messages,
        tools,
        toolChoice: forceToolChoice && round === 0 && pauseTurnSteps === 0 ? "any" : "auto",
      };
      if (pauseTurnSteps === 0) {
        const fullPromptRound = formatThreadPromptForLog(roundRequest.systemBlocks, messages);
        console.log("[Claude thread] full prompt (round %d):\n%s", round, fullPromptRound);
      }

      data = await invoke<ClaudeThreadProxyRoundData>("ask_claude_thread_proxy", {
        request: roundRequest,
      });

      if (data.webSearchRequests) {
        totalWebSearchRequests += data.webSearchRequests;
      }

      const webSearchQueries = extractWebSearchQueries(data.rawContent ?? []);
      for (const query of webSearchQueries) {
        emitToolEvent({ type: "web_search_call", query });
      }
      for (const label of extractWebSearchResultLabels(data.rawContent ?? [])) {
        emitToolEvent({ type: "web_search_result", label });
      }

      const hasToolCallsHere = (data.toolCalls?.length ?? 0) > 0;
      const isPauseTurn = data.stopReason === "pause_turn";
      console.log(
        "[Claude thread] round=%d pauseStep=%d toolChoice=%s stopReason=%s tools=%o",
        round,
        pauseTurnSteps,
        forceToolChoice && round === 0 && pauseTurnSteps === 0 ? "any" : "auto",
        data.stopReason,
        tools.map((t: unknown) => (t as { name: string }).name)
      );
      console.log("[Claude thread] answer=%o toolCalls=%o webSearchRequests=%o", data.answer, data.toolCalls, data.webSearchRequests);
      if (data.toolCalls?.length) {
        for (const call of data.toolCalls) {
          console.log("[Claude thread] tool_call name=%s input=%o", call.name, call.input);
        }
      }
      if (data.usage) {
        console.log("[Claude thread usage]", data.usage);
      }

      if (hasToolCallsHere || !isPauseTurn) break;

      if (pauseTurnSteps >= 10) {
        console.warn("[Claude thread] pause_turn exceeded max continues (10)");
        break;
      }
      pauseTurnSteps++;
      console.log("[Claude thread] pause_turn detected, continuing server-side tool loop (step %d)", pauseTurnSteps);
      messages = [
        ...messages,
        { role: "assistant" as const, content: data.rawContent },
        { role: "user" as const, content: "Continue." },
      ];
      if (allowSingleWebSearch && (data.webSearchRequests ?? 0) > 0) {
        allowSingleWebSearch = false;
      }
    }

    const hasToolCalls = (data.toolCalls?.length ?? 0) > 0;
    const stuckPauseTurn = !hasToolCalls && data.stopReason === "pause_turn";
    if (stuckPauseTurn) {
      console.warn("[Claude thread] ending with stop_reason pause_turn (partial response)");
      const answer = data.answer ?? "";
      const webCitations = extractWebCitations(data.rawContent ?? []);
      const completedManifest: ContextManifest = {
        ...assembled.manifestDraft,
        toolsAvailable,
        toolCallsMade: [...toolCallLog],
        finalAnswerChars: answer.length,
        webSearchesUsed: totalWebSearchRequests || undefined,
      };
      invoke("db_save_manifest", { manifest: completedManifest }).catch(console.error);
      return {
        answer,
        model: data.model ?? model,
        usage: data.usage,
        completedManifest,
        webCitations: webCitations.length > 0 ? webCitations : undefined,
        toolEvents: turnToolEvents.length > 0 ? turnToolEvents : undefined,
      };
    }

    if (!hasToolCalls) {
      const answer = data.answer ?? "";
      const webCitations = extractWebCitations(data.rawContent);
      const completedManifest: ContextManifest = {
        ...assembled.manifestDraft,
        toolsAvailable,
        toolCallsMade: [...toolCallLog],
        finalAnswerChars: answer.length,
        webSearchesUsed: totalWebSearchRequests || undefined,
      };
      invoke("db_save_manifest", { manifest: completedManifest }).catch(console.error);
      return {
        answer,
        model: data.model ?? model,
        usage: data.usage,
        completedManifest,
        webCitations: webCitations.length > 0 ? webCitations : undefined,
        toolEvents: turnToolEvents.length > 0 ? turnToolEvents : undefined,
      };
    }

    for (const call of data.toolCalls!) {
      const callLabel =
        call.name === "get_context"
          ? "Reading nearby text…"
          : call.name === "get_section_summary"
            ? "Fetching section summary…"
            : call.name === "get_section_text"
              ? "Loading section text…"
              : call.name === "get_past_thread"
                ? "Opening archived thread…"
                : call.name === "suggest_smart_scan"
                  ? "Suggesting Smart Scan…"
                  : call.name === "request_web_search"
                    ? "Waiting for web search approval…"
                  : `Running ${call.name}…`;
      emitToolEvent({ type: "tool_call", label: callLabel });
      const summary =
        call.name === "get_context"
          ? `cfi=${(String((call.input as { cfi?: string }).cfi ?? "")).slice(0, 40)}… dir=${(call.input as { direction?: string }).direction ?? "?"} max=${(call.input as { max_chars?: number }).max_chars ?? "?"}`
          : call.name === "get_section_summary" || call.name === "get_section_text"
            ? `spine_href=${String((call.input as { spine_href?: string }).spine_href ?? "")}`
            : call.name === "get_past_thread"
              ? `thread_id=${String((call.input as { thread_id?: string }).thread_id ?? "")}`
            : call.name === "suggest_smart_scan"
              ? "(no input)"
              : call.name === "request_web_search"
                ? `query=${String((call.input as { query?: string }).query ?? "")}`
              : "(unknown)";
      toolCallLog.push({
        tool: call.name,
        round,
        inputSummary: summary,
        toolUseId: call.id,
        input: { ...(call.input ?? {}) },
      });
    }

    const toolResults = await Promise.all(
      data.toolCalls!.map(async (call) => {
        const startedAt = Date.now();
        const logIndex = toolCallLog.findIndex((entry) => entry.toolUseId === call.id);
        const completeLog = (result: { tool_use_id: string; content: string }) => {
          if (logIndex >= 0) {
            toolCallLog[logIndex].output = result.content;
            toolCallLog[logIndex].durationMs = Date.now() - startedAt;
          }
          return result;
        };
        const failLog = (error: unknown) => {
          if (logIndex >= 0) {
            toolCallLog[logIndex].error = error instanceof Error ? error.message : String(error);
            toolCallLog[logIndex].durationMs = Date.now() - startedAt;
          }
        };
        if (call.name === "get_context") {
          const { cfi, direction, max_chars } = call.input as {
            cfi?: string;
            direction?: string;
            max_chars?: number;
          };
          if (!cfi || !cfi.trim()) {
            return completeLog({
              tool_use_id: call.id,
              content: "(get_context requires a non-empty EPUB CFI.)",
            });
          }
          const isEpubCfi =
            typeof cfi === "string" && cfi.trim().toLowerCase().startsWith("epubcfi(");
          if (!isEpubCfi) {
            const content =
              "(get_context requires an EPUB CFI from the user's passage, e.g. epubcfi(/6/4!/4/2/1:0). You passed a spine href or path — get_context cannot fetch by section. For another section use get_section_summary or get_section_text.)";
            return completeLog({ tool_use_id: call.id, content });
          }
          const dir =
            direction === "before" ||
            direction === "after" ||
            direction === "around" ||
            direction === "from_section_start"
              ? direction
              : "around";
          const maxChars = Math.min(Math.max(0, max_chars ?? 4000), 40000);
          const anchorText =
            params.pendingExcerpt?.text?.trim() ||
            getInheritedThreadPassage(params.messages)?.excerptText?.trim() ||
            undefined;
          try {
            const result = params.getContextAroundCfi(cfi, dir, maxChars, anchorText);
            const content = JSON.stringify(result);
            if (result.text?.trim()) params.onContextFetched?.(result.text);
            emitToolEvent({ type: "tool_result", label: "Loaded nearby text." });
            return completeLog({ tool_use_id: call.id, content });
          } catch (error) {
            failLog(error);
            emitToolEvent({ type: "tool_result", label: "Context fetch failed." });
            return completeLog({
              tool_use_id: call.id,
              content: `(get_context failed: ${error instanceof Error ? error.message : String(error)})`,
            });
          }
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
          emitToolEvent({ type: "tool_result", label: "Loaded section summary." });
          return completeLog({ tool_use_id: call.id, content });
        }
        if (call.name === "get_section_text") {
          const { spine_href } = call.input as { spine_href: string };
          try {
            const text =
              params.getSectionTextByHref != null
                ? await params.getSectionTextByHref(spine_href)
                : "";
            const content =
              text?.trim() || `(Could not load full text for section "${spine_href}". Section may not exist or failed to load.)`;
            emitToolEvent({ type: "tool_result", label: "Loaded section text." });
            return completeLog({ tool_use_id: call.id, content });
          } catch (error) {
            failLog(error);
            emitToolEvent({ type: "tool_result", label: "Section text fetch failed." });
            return completeLog({
              tool_use_id: call.id,
              content: `(get_section_text failed for "${spine_href}": ${error instanceof Error ? error.message : String(error)})`,
            });
          }
        }
        if (call.name === "get_past_thread") {
          const { thread_id } = call.input as { thread_id?: string };
          const id = (thread_id ?? "").trim();
          if (!id) {
            return completeLog({ tool_use_id: call.id, content: "(thread_id is required)" });
          }
          try {
            const content = params.getPastThreadMessages
              ? (await params.getPastThreadMessages(id)).trim() || `(No archived exchange found for thread "${id}".)`
              : "(get_past_thread unavailable in this session)";
            emitToolEvent({ type: "tool_result", label: "Loaded archived thread." });
            return completeLog({ tool_use_id: call.id, content });
          } catch (error) {
            failLog(error);
            emitToolEvent({ type: "tool_result", label: "Archived thread fetch failed." });
            return completeLog({
              tool_use_id: call.id,
              content: `(get_past_thread failed for "${id}": ${error instanceof Error ? error.message : String(error)})`,
            });
          }
        }
        if (call.name === "suggest_smart_scan") {
          suggestSmartScanUsed = true;
          params.onSuggestSmartScan?.();
          emitToolEvent({ type: "tool_result", label: "Suggested Smart Scan." });
          return completeLog({
            tool_use_id: call.id,
            content: "(Smart Scan suggestion surfaced to user)",
          });
        }
        if (call.name === "request_web_search") {
          const rawQuery = String((call.input as { query?: string }).query ?? "").trim();
          if (!rawQuery) {
            emitToolEvent({ type: "web_search_decision", label: "Web search denied." });
            return completeLog({
              tool_use_id: call.id,
              content: "(web_search permission denied: missing query)",
            });
          }
          emitToolEvent({ type: "web_search_call", query: rawQuery });
          const decision = params.requestWebSearchPermission
            ? await params.requestWebSearchPermission(rawQuery)
            : "deny";
          if (decision === "allow_thread") {
            webSearchPermissionScope = "allow_thread";
            emitToolEvent({ type: "web_search_decision", label: "Web search allowed for this thread." });
            return completeLog({
              tool_use_id: call.id,
              content: `(web_search approved for this thread: "${rawQuery}")`,
            });
          }
          if (decision === "allow_once") {
            allowSingleWebSearch = true;
            emitToolEvent({ type: "web_search_decision", label: "Web search allowed once." });
            return completeLog({
              tool_use_id: call.id,
              content: `(web_search approved once: "${rawQuery}")`,
            });
          }
          emitToolEvent({ type: "web_search_decision", label: "Web search denied." });
          return completeLog({
            tool_use_id: call.id,
            content: `(web_search denied by user for "${rawQuery}")`,
          });
        }
        emitToolEvent({ type: "tool_result", label: `Unknown tool: ${call.name}.` });
        return completeLog({ tool_use_id: call.id, content: "(Unknown tool)" });
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
    rawContent: unknown[];
    model: string;
    usage?: ClaudeResponse["usage"];
    webSearchRequests?: number;
  }>("ask_claude_thread_proxy", {
    request: finalRequest,
  });
  if (finalData.webSearchRequests) {
    totalWebSearchRequests += finalData.webSearchRequests;
  }
  const answer = finalData.answer ?? "";
  const webCitations = extractWebCitations(finalData.rawContent);
  const completedManifest: ContextManifest = {
    ...assembled.manifestDraft,
    toolsAvailable,
    toolCallsMade: [...toolCallLog],
    finalAnswerChars: answer.length,
    webSearchesUsed: totalWebSearchRequests || undefined,
  };
  invoke("db_save_manifest", { manifest: completedManifest }).catch(console.error);
  return {
    answer,
    model: finalData.model ?? model,
    usage: finalData.usage,
    completedManifest,
    webCitations: webCitations.length > 0 ? webCitations : undefined,
    toolEvents: turnToolEvents.length > 0 ? turnToolEvents : undefined,
  };
}
