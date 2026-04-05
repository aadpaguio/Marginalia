import { invoke } from "@tauri-apps/api/core";
import type { Highlight, MemoryItem, ThreadMessage, WebCitation } from "@/types/book";
import type {
  ContextManifest,
  ContextAnchorSource,
  ContextTurnMode,
} from "@/types/contextManifest";
import type { SectionSummary } from "@/services/db";
import { memoryGetItemsForBook, memoryGetItemsGlobal } from "@/services/db";

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
  /** Web search citations from Anthropic's server-side web_search tool. */
  webCitations?: WebCitation[];
}

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

/** Phase 30.5: Load up to 5 relevant memory items (global high-obs + book-scoped + optional cross-book global). */
export async function loadRelevantMemoryItems(
  bookId: string,
  userMessage: string
): Promise<MemoryItem[]> {
  const [bookItems, globalItems] = await Promise.all([
    memoryGetItemsForBook(bookId),
    memoryGetItemsGlobal(),
  ]);
  const globalHighObs = globalItems
    .filter((i) => i.observationCount >= 3)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  const topBook = bookItems
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  const crossBookSignals = /\b(have i seen this before|reminds me of|across books|other books|another book)\b/i.test(
    userMessage
  );
  const seen = new Set<string>();
  const out: MemoryItem[] = [];
  for (const i of globalHighObs) {
    if (out.length >= 5) break;
    if (!seen.has(i.id)) {
      seen.add(i.id);
      out.push(i);
    }
  }
  for (const i of topBook) {
    if (out.length >= 5) break;
    if (!seen.has(i.id)) {
      seen.add(i.id);
      out.push(i);
    }
  }
  if (crossBookSignals && out.length < 5) {
    const moreGlobal = globalItems
      .sort((a, b) => b.confidence - a.confidence)
      .filter((i) => !seen.has(i.id))
      .slice(0, 5 - out.length);
    for (const i of moreGlobal) {
      out.push(i);
      if (out.length >= 5) break;
    }
  }
  return out.slice(0, 5);
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
  if (params.bookSummary?.trim()) {
    systemParts.push(`--- BOOK OVERVIEW ---\n${params.bookSummary.trim()}`);
  }
  // --- SECTION INDEX --- (single collapsed list: spine_href | section name | spine N | type | tokens | radii | [ahead])
  if (
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
        `\n\nFor get_context: use direction (before / after / around / from_section_start) and max_chars (snippet ~2000, section ~8000, full ~20000). Only use [ahead] sections if the reader asks about content ahead; flag spoilers.`
    );
  }
  // --- TOOLS & CONTEXT ---
  systemParts.push(
    "--- TOOLS & CONTEXT ---\n" +
    "The reader only ever sees your final message. They do not see tool calls, tool output, or any text you fetched. So: never imply they can see it. Do not say 'as you can see from the context', 'what I retrieved shows', 'the passage I pulled', 'in the text I fetched', or similar. Answer as if the relevant content were already in front of you — quote or paraphrase it in your reply; that is the only way the reader gets the information.\n" +
    "Two normal turn types: (1) When a passage is attached to the message, you have that passage and the reader's question — use it as your default evidence base. (2) When no passage is attached but an ACTIVE THREAD PASSAGE (inherited) block is present below, this turn inherits the most recent thread passage — use it as the default anchor and its CFI for get_context when needed. (3) When no passage is attached and there is no active thread passage, this is a freeform thread question: you have only the reader's question. Only ask the user to point to the text again when there is no active anchor (no passage on this message and no ACTIVE THREAD PASSAGE block). Do not assume the reader has read beyond what is in front of them.\n" +
    "When to use tools:\n" +
    "- get_context (CFI + direction + max_chars): Use when the question needs text around the reader's current passage. Pass the EPUB CFI and direction: use 'from_section_start' when you need what led up to the anchor from the start of the chapter/section; 'before' for immediate lead-up; 'after' for what follows; 'around' for local context. Use max_chars (snippet ~2000, section ~8000, full ~20000). The tool returns atSectionStart, atSectionEnd, charsBefore, charsAfter so you can reason about position (e.g. 'there may not be much prior context yet'). Use it in this turn if you need it; no need to ask first.\n" +
    "Attribution and source-identification: Do not answer attribution questions (e.g. 'what essay is this from?', 'who is speaking?', 'which chapter/section?') by inference or prior knowledge. You may only state a source, speaker, or title if it is explicitly stated in the attached passage or in the CURRENT TURN LEAD-UP CONTEXT block. If the attached passage and CURRENT TURN LEAD-UP CONTEXT together do not explicitly name the source, speaker, or essay, you must call get_context before answering — do not guess. For source-attribution in quoted or critical prose, when the lead-up (before) context does not resolve the attribution, call get_context with direction 'around' or 'after' to look for the title or speaker; then answer only from what the fetched text explicitly states.\n" +
    "- get_section_summary (spine_href): Use to get the summary of a section by its spine_href (from the section index). Helps with thematic questions or deciding if you need that section's full text.\n" +
    "- get_section_text (spine_href): Use when the reader wants exact quotes or specific lines from a section they have not reached. Pass the spine_href from the section index.\n" +
    "Spoilers: Do not assume the reader has read past the excerpt. If the answer would spoil later content and they did not ask for it, hint instead (e.g. 'this becomes clearer as you read further').\n" +
    "Broader scope: If answering would require content from sections the reader has not reached (e.g. get_section_summary or get_section_text for later sections) or would spoil later material, prefer to say so and ask before fetching or summarising that content."
  );
  // --- RESPONSE RULES ---
  systemParts.push(
    "--- RESPONSE RULES ---\n" +
    "Don't overexplain unless asked further by the user." +
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

  // Phase 30.5: inject memory items as first user block when present (no empty block)
  const memoryBlock =
    params.memoryItems && params.memoryItems.length > 0
      ? params.memoryItems
          .map(
            (i) =>
              `— ${i.content} (${i.type}, seen ${i.observationCount}×${i.anchors?.some((a) => a.bookId) ? ", book" : ""})`
          )
          .join("\n")
      : "";
  const prefillMessages: AssembledThreadRequest["messages"] =
    memoryBlock.length > 0
      ? [
          {
            role: "user" as const,
            content: `[MEMORY CONTEXT]\n${memoryBlock}\n[/MEMORY CONTEXT]`,
          },
        ]
      : [];

  const systemBlocks: AssembledThreadRequest["systemBlocks"] = [
    { text: systemParts.join("\n\n"), cacheControl: "ephemeral" },
  ];
  if (params.prefetchedLeadUpContext?.trim()) {
    systemBlocks.push({
      text: `--- CURRENT TURN LEAD-UP CONTEXT ---\nText immediately before the reader's attached passage (this turn only). Use it to ground attribution or identification answers; it is not carried to later turns.\n\n${params.prefetchedLeadUpContext.trim()}`,
      cacheControl: "ephemeral",
    });
  }
  if (params.workingContext?.trim()) {
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
  const allMessages = [...prefillMessages, ...historyMessages, currentTurn];
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
    memoryItemsCount: params.memoryItems?.length ?? 0,
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
    "Retrieve text from the book around the reader's passage anchor. Pass the EPUB CFI from the user's message or ACTIVE THREAD PASSAGE (inherited), plus direction and max_chars. Use 'from_section_start' when you need what led up to the anchor from the start of the chapter/section; 'before' for immediate lead-up; 'after' for what follows; 'around' for local context on both sides. The tool returns sectionLabel, charsBefore, charsAfter, atSectionStart, atSectionEnd, and text — use these to reason about position (e.g. 'this is early in the chapter'). Do NOT pass a spine href: for another section use get_section_summary or get_section_text.",
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

export type AskClaudeThreadParams = ThreadContextParams & {
  getContextAroundCfi: (
    cfi: string,
    direction: GetContextDirection,
    maxChars: number,
    anchorText?: string
  ) => GetContextResult;
  /** When provided, enables get_section_text so the model can fetch full text of a section by spine_href and quote lines. */
  getSectionTextByHref?: (spineHref: string) => Promise<string>;
  /** Called when the model invokes a tool (e.g. get_context) so the UI can show a fetch indicator. */
  onToolCall?: (toolName: string) => void;
  /** Called when get_context returns; App uses this to update session-only working context (ref) for the next turn. */
  onContextFetched?: (text: string) => void;
  /** When true, includes Anthropic's server-side web_search tool so Claude can look up external information. */
  webSearchEnabled?: boolean;
  /** Called when the response contains web search activity (server_tool_use for web_search). */
  onWebSearch?: () => void;
};

const MAX_TOOL_ROUNDS = 3;

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

export async function askClaudeThread(
  params: AskClaudeThreadParams,
  apiKey: string
): Promise<ClaudeResponse> {
  // One-time auto-prefetch for current-turn attached passage only (before first API call). Not sent through onContextFetched.
  // Best-effort: if prefetch throws (e.g. resolver edge case), continue without a lead-up block so the turn still reaches the model.
  let prefetchedLeadUpContext: string | undefined;
  if (params.pendingExcerpt?.text?.trim() && params.pendingExcerpt?.cfi?.trim()) {
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
  const toolCallLog: Array<{ tool: string; round: number; inputSummary: string }> = [];

  /**
   * Force tool use on round 0 only when the user's message explicitly asks for
   * surrounding/relational context (e.g. "how does this relate to the rest of the essay").
   * Do not force for simple clarifications (e.g. "what does X mean") — the model can
   * answer from the passage. Subsequent rounds always use "auto".
   */
  const forceToolChoice = isContextSeekingQuery(params.userMessage);
  let suggestSmartScanUsed = false;
  let totalWebSearchRequests = 0;

  // Round-0 tool list for manifest (what options the model had when it started)
  const round0Tools: unknown[] = [GET_CONTEXT_TOOL];
  if (params.scanStatus === "done" && (params.sectionSummaries?.length ?? 0) > 0) {
    round0Tools.push(GET_SECTION_SUMMARY_TOOL);
    if (params.getSectionTextByHref) round0Tools.push(GET_SECTION_TEXT_TOOL);
  }
  if (params.scanStatus === "none") {
    round0Tools.push(SUGGEST_SMART_SCAN_TOOL);
  }
  if (params.webSearchEnabled) {
    round0Tools.push(WEB_SEARCH_TOOL);
  }
  const toolsAvailable = round0Tools.map((t) => (t as { name: string }).name);

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
    if (params.webSearchEnabled) {
      tools.push(WEB_SEARCH_TOOL);
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
      stopReason?: string;
      webSearchRequests?: number;
    }>("ask_claude_thread_proxy", {
      request: roundRequest,
    });

    if (data.webSearchRequests) {
      totalWebSearchRequests += data.webSearchRequests;
    }

    const hasWebSearchActivity = (data.rawContent ?? []).some(
      (b: unknown) => {
        const block = b as { type?: string; name?: string };
        return block.type === "server_tool_use" && block.name === "web_search";
      }
    );
    if (hasWebSearchActivity) {
      params.onWebSearch?.();
    }

    const hasToolCalls = (data.toolCalls?.length ?? 0) > 0;
    const isPauseTurn = data.stopReason === "pause_turn";
    console.log("[Claude thread] round=%d toolChoice=%s stopReason=%s tools=%o", round, forceToolChoice && round === 0 ? "any" : "auto", data.stopReason, tools.map((t: unknown) => (t as { name: string }).name));
    console.log("[Claude thread] answer=%o toolCalls=%o webSearchRequests=%o", data.answer, data.toolCalls, data.webSearchRequests);
    if (data.toolCalls?.length) {
      for (const call of data.toolCalls) {
        console.log("[Claude thread] tool_call name=%s input=%o", call.name, call.input);
      }
    }
    if (data.usage) {
      console.log("[Claude thread usage]", data.usage);
    }

    // Server-side tool (web search) still running — continue the conversation
    if (!hasToolCalls && isPauseTurn) {
      console.log("[Claude thread] pause_turn detected, continuing server-side tool loop");
      messages = [
        ...messages,
        { role: "assistant" as const, content: data.rawContent },
        { role: "user" as const, content: "Continue." },
      ];
      continue;
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
      };
    }

    for (const call of data.toolCalls!) {
      if (call.name !== "suggest_smart_scan") {
        params.onToolCall?.(call.name);
      }
      const summary =
        call.name === "get_context"
          ? `cfi=${(String((call.input as { cfi?: string }).cfi ?? "")).slice(0, 40)}… dir=${(call.input as { direction?: string }).direction ?? "?"} max=${(call.input as { max_chars?: number }).max_chars ?? "?"}`
          : call.name === "get_section_summary" || call.name === "get_section_text"
            ? `spine_href=${String((call.input as { spine_href?: string }).spine_href ?? "")}`
            : call.name === "suggest_smart_scan"
              ? "(no input)"
              : "(unknown)";
      toolCallLog.push({ tool: call.name, round, inputSummary: summary });
    }

    const toolResults = await Promise.all(
      data.toolCalls!.map(async (call) => {
        if (call.name === "get_context") {
          const { cfi, direction, max_chars } = call.input as {
            cfi: string;
            direction?: string;
            max_chars?: number;
          };
          const isEpubCfi =
            typeof cfi === "string" && cfi.trim().toLowerCase().startsWith("epubcfi(");
          if (!isEpubCfi) {
            const content =
              "(get_context requires an EPUB CFI from the user's passage, e.g. epubcfi(/6/4!/4/2/1:0). You passed a spine href or path — get_context cannot fetch by section. For another section use get_section_summary or get_section_text.)";
            return { tool_use_id: call.id, content };
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
          const result = params.getContextAroundCfi(cfi, dir, maxChars, anchorText);
          const content = JSON.stringify(result);
          if (result.text?.trim()) params.onContextFetched?.(result.text);
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
  };
}
