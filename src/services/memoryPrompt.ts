/**
 * Memory prompt formatting and retrieval helpers (structured system injection, not synthetic chat).
 */
import type { MemoryItem, MemoryItemType, MemoryScope, MemoryUsageMode } from "@/types/book";

const MIN_INJECTED_WORDS = 4;
/** After aggressive stripping, allow slightly shorter recovered lines so legacy memories still inject. */
const MIN_RECOVERED_WORDS = 3;

/** Phrases that encourage performative "callback" replies; strip or rewrite before injection. */
const CONVERSATIONAL_CALLBACK_PATTERNS: RegExp[] = [
  /\byou\s+asked\s+before\b[^.]*\.?/gi,
  /\bearly\s+on\s+you\s+asked\b[^.]*\.?/gi,
  /\bearlier\s+you\s+asked\b[^.]*\.?/gi,
  /\bin\s+a\s+previous\s+thread\b[^.]*\.?/gi,
  /\bin\s+previous\s+threads?\b[^.]*\.?/gi,
  /\bwe\s+discussed\b[^.]*\.?/gi,
  /\bwe\s+talked\s+about\b[^.]*\.?/gi,
  /\byou\s+mentioned\s+before\b[^.]*\.?/gi,
  /\bas\s+you\s+said\s+earlier\b[^.]*\.?/gi,
  /\bpreviously\s+you\b[^.]*\.?/gi,
  /\blast\s+time\s+you\b[^.]*\.?/gi,
];

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "as", "is", "was",
  "are", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "shall", "can", "this", "that", "these", "those",
  "it", "its", "you", "your", "how", "what", "when", "where", "why", "who", "which",
]);

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Split on sentence boundaries for per-sentence cleanup. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Remove common conversational openers from the start only (preserves the substantive tail).
 */
function stripLeadingConversationalClauses(raw: string): string {
  let s = raw.trim();
  const leadPatterns: RegExp[] = [
    /^(?:you\s+asked\s+before\s+about|you\s+asked\s+before)\s*[,:]?\s*/gi,
    /^(?:earlier\s+you\s+asked\s+about|earlier\s+you\s+asked)\s*[,:]?\s*/gi,
    /^(?:early\s+on\s+you\s+asked)\s*[,:]?\s*/gi,
    /^(?:in\s+a\s+previous\s+thread,?\s*|in\s+previous\s+threads?,?\s*)/gi,
    /^(?:we\s+discussed|we\s+talked\s+about)\s*[,:]?\s*/gi,
    /^(?:you\s+mentioned\s+before)\s*[,:]?\s*/gi,
    /^(?:as\s+you\s+said\s+earlier)\s*[,:]?\s*/gi,
    /^(?:previously\s+you|last\s+time\s+you)\s*[,:]?\s*/gi,
  ];
  let prev = "";
  while (prev !== s) {
    prev = s;
    for (const re of leadPatterns) {
      s = s.replace(re, "").trim();
    }
  }
  return s.replace(/^(?:[,;:\s]+|and\s+|so\s+|that\s+)+/i, "").trim();
}

function tokenizeForOverlap(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

/** Derive scope from anchors (e.g. legacy rows). */
export function inferMemoryScopeFromAnchors(item: MemoryItem): MemoryScope {
  const hasBook = item.anchors?.some((a) => (a.bookId ?? "").trim().length > 0);
  const hasPassageEvidence = item.anchors?.some(
    (a) =>
      ((a.cfi ?? "").trim().length > 0 || (a.passageText ?? "").trim().length > 0) &&
      (a.bookId ?? "").trim().length > 0
  );
  if (hasPassageEvidence) return "passage";
  if (hasBook) return "book";
  return "global";
}

/**
 * Strip conversational framing from legacy memory prose. Uses recovery paths so
 * "you asked before about X…" still yields injectable X when possible.
 */
export function sanitizeMemoryContentForPrompt(content: string): string | null {
  const original = content.trim();
  if (!original) return null;

  let s = original;
  for (const re of CONVERSATIONAL_CALLBACK_PATTERNS) {
    s = s.replace(re, " ").replace(/\s+/g, " ").trim();
  }
  s = s.replace(/^(?:[,;:\s]+|and\s+|so\s+|that\s+|when\s+)*/i, "").trim();
  if (countWords(s) >= MIN_INJECTED_WORDS) return s;

  // Recovery: clean each sentence, join those that still have substance.
  const fromSentences = splitSentences(original)
    .map((sent) => {
      let t = sent.trim();
      for (const re of CONVERSATIONAL_CALLBACK_PATTERNS) {
        t = t.replace(re, " ").replace(/\s+/g, " ").trim();
      }
      return t.replace(/^(?:[,;:\s]+|and\s+|so\s+|that\s+|when\s+)*/i, "").trim();
    })
    .filter((t) => countWords(t) >= MIN_RECOVERED_WORDS);
  const joined = fromSentences.join(" ").replace(/\s+/g, " ").trim();
  if (countWords(joined) >= MIN_INJECTED_WORDS) return joined;
  if (countWords(joined) >= MIN_RECOVERED_WORDS && fromSentences.length > 0) return joined;

  // Recovery: strip leading chatty clauses only, keep tail (handles single-sentence memories).
  const tail = stripLeadingConversationalClauses(original);
  if (countWords(tail) >= MIN_INJECTED_WORDS) return tail;
  if (countWords(tail) >= MIN_RECOVERED_WORDS && tail.length > 0) return tail;

  return null;
}

export interface PromptReadyMemoryItem {
  item: MemoryItem;
  contentForPrompt: string;
  scope: MemoryScope;
  usageMode: MemoryUsageMode;
}

function defaultUsageMode(scope: MemoryScope, type: MemoryItemType): MemoryUsageMode {
  if (scope === "global" && (type === "preference" || type === "reading_identity")) {
    return "implicit";
  }
  return "implicit";
}

export function promptReadyMemoryItem(item: MemoryItem): PromptReadyMemoryItem | null {
  const sanitized = sanitizeMemoryContentForPrompt(item.content);
  if (!sanitized) return null;
  const scope = item.scope;
  const usageMode = item.usageMode ?? defaultUsageMode(scope, item.type);
  return { item: { ...item, content: item.content }, contentForPrompt: sanitized, scope, usageMode };
}

/**
 * Structured --- MEMORY --- block body (header / instructions are added in claude.ts).
 */
export function formatMemoryItemsSystemBlock(
  items: PromptReadyMemoryItem[]
): string {
  const lines: string[] = [];
  for (const pr of items) {
    const anchorThreadId = pr.item.anchors?.find((a) => !!a.threadId)?.threadId;
    const parts = [
      `- type: ${pr.item.type}`,
      `  scope: ${pr.scope}`,
      `  usageMode: ${pr.usageMode}`,
    ];
    if (anchorThreadId) parts.push(`  thread: ${anchorThreadId}`);
    parts.push(`  content: ${pr.contentForPrompt}`);
    lines.push(parts.join("\n"));
  }
  return lines.join("\n");
}

const GLOBAL_GUIDANCE_TYPES: Set<MemoryItemType> = new Set([
  "reading_identity",
  "intellectual",
  "preference",
  "emotional",
]);

/**
 * Minimum relevance: drop cross-book items unless the query clearly relates.
 */
export function shouldIncludeMemoryItemForQuery(
  item: MemoryItem,
  userMessage: string,
  currentBookId: string
): boolean {
  const scope = item.scope;
  const q = userMessage.trim();
  const qTokens = tokenizeForOverlap(q);

  if (item.type === "cross_book_pattern") {
    if (qTokens.size === 0) return false;
    const cTokens = tokenizeForOverlap(item.content);
    let overlap = 0;
    for (const t of qTokens) {
      if (cTokens.has(t)) overlap++;
    }
    if (overlap >= 2) return true;
    const litHints =
      /\b(other|another|compare|contrast|earlier\s+book|different\s+book|across\s+books?)\b/i.test(q);
    return litHints && overlap >= 1;
  }

  if (scope === "book" || scope === "passage") {
    const anchorBookIds = item.anchors?.map((a) => a.bookId).filter(Boolean) as string[];
    if (anchorBookIds.length === 0) return true;
    return anchorBookIds.includes(currentBookId);
  }

  // global
  if (GLOBAL_GUIDANCE_TYPES.has(item.type)) return true;
  if (item.type === "book_insight" || item.type === "book_question" || item.type === "book_reaction") {
    return item.anchors?.some((a) => a.bookId === currentBookId) ?? false;
  }
  return true;
}

/**
 * Prefer stable reader-style globals first, then book-specific, then rest (cap enforced upstream).
 */
export function rankMemoryItemsForPrompt(items: MemoryItem[]): MemoryItem[] {
  const score = (i: MemoryItem): number => {
    const scope = i.scope;
    let s = 0;
    if (scope === "global" && GLOBAL_GUIDANCE_TYPES.has(i.type)) s += 100;
    if (scope === "book" && GLOBAL_GUIDANCE_TYPES.has(i.type)) s += 80;
    if (scope === "book" || scope === "passage") s += 40;
    s += Math.min(20, i.observationCount ?? 0);
    s += (i.confidence ?? 0.5) * 10;
    s += (i.lastReinforcedAt ?? 0) / 1e15;
    return s;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}
