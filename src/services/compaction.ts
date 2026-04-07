/**
 * Phase 26: Book memory compaction and reader profile extraction.
 * Phase 30.4: Extract structured memory items from archived threads.
 * Uses Haiku for summarization; memory files are plain Markdown.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Highlight, Thread, ThreadMessage } from "@/types/book";
import {
  memoryGetItemsForBook,
  memoryGetItemsGlobal,
  memoryReinforceItem,
  memorySaveItem,
  type MemoryAnchorInput,
  type MemoryItemInput,
} from "@/services/db";

const COMPACTION_MODEL = "claude-haiku-4-5-20251001";

/** Filter for full-thread archive extraction: relaxed so short model outputs still persist (was 50–100). */
const MEMORY_ITEM_ARCHIVE_MIN_WORDS = 12;
const MEMORY_ITEM_ARCHIVE_MAX_WORDS = 120;

function formatThreadForPrompt(messages: ThreadMessage[]): string {
  return messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join("\n\n");
}

/** Phase 30.2: Derive chapter range from attached highlights for journal entry tagging. Sorts by leading number when present (e.g. Chapter 2, Chapter 10) to avoid lexicographic order. */
export function extractChapterRange(highlights: { chapterLabel?: string | null }[]): string {
  const labels = highlights
    .map((h) => (h.chapterLabel ?? "").trim())
    .filter(Boolean);
  if (labels.length === 0) return "";
  const unique = [...new Set(labels)];
  if (unique.length === 1) return unique[0];
  const withNum = unique.map((l) => {
    const n = l.match(/^\D*(\d+)/)?.[1];
    return { label: l, num: n != null ? parseInt(n, 10) : null };
  });
  withNum.sort((a, b) => {
    if (a.num != null && b.num != null) return a.num - b.num;
    if (a.num != null) return -1;
    if (b.num != null) return 1;
    return a.label.localeCompare(b.label);
  });
  return `${withNum[0].label}–${withNum[withNum.length - 1].label}`;
}

/** Returns the new journal entry (~50–100 words) to append. */
// --- Phase 30.4: structured memory extraction ---

export interface ExtractedMemoryItem {
  content: string;
  type: string;
  confidence: number;
  scope: "global" | "book" | "passage";
  passage_text: string | null;
}

/** Normalize string for similarity: lowercase, collapse whitespace. */
function normalizeForSimilarity(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Simple normalized-string similarity (no embeddings). Returns true if a and b are near-duplicate. */
export function isNearDuplicate(a: string, b: string, threshold = 0.85): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length < nb.length ? na : nb;
  if (longer.includes(shorter)) return true;
  const maxLen = longer.length;
  let matchLen = 0;
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    let k = 0;
    while (i + k < maxLen && k < shorter.length && longer[i + k] === shorter[k]) k++;
    if (k > matchLen) matchLen = k;
  }
  return matchLen / shorter.length >= threshold;
}

/** Extract 3–6 substantive memory items from a thread via Haiku. Returns empty array on parse failure. */
export async function extractMemoryItems(params: {
  thread: Thread;
  messages: ThreadMessage[];
  attachedHighlights: Highlight[];
  bookId: string;
  bookTitle: string;
  author: string;
  apiKey: string;
}): Promise<ExtractedMemoryItem[]> {
  const { thread, messages, bookTitle, author, apiKey } = params;
  const threadBlock = formatThreadForPrompt(messages);
  const systemPrompt = `You are extracting structured memory from a reading discussion.

Book: ${bookTitle} by ${author}
Thread: ${thread.title ?? "Discussion"}

The transcript uses [user] for the human reader and [assistant] for Marginalia (the app's reading assistant). Treat them as two speakers; do not merge their contributions.

${threadBlock}

Extract 3–6 discrete memory items worth keeping for future reading chats.
Each item must stand alone: aim for ~20–80 words when the transcript supports it; never fluff—short grounded items (roughly 12+ words) are fine if that is all the discussion warrants.
Prioritize what the human actually contributed: questions they asked, opinions they stated, reactions they expressed, preferences they gave.
Include key unresolved questions when they exist.
You may also record a joint thread fact using "we" when both sides genuinely participated, but never credit the user with ideas that appear only in [assistant].

Return ONLY a JSON array. No preamble, no markdown fences.

[
  {
    "content": "Substantive prose with correct attribution (see rules below); ~20–80 words typical, minimum ~12 when the source is thin.",
    "type": "reading_identity|intellectual|emotional|preference|book_insight|book_question|book_reaction",
    "confidence": 0.5,
    "scope": "global|book|passage",
    "passage_text": "exact quote if passage-specific, otherwise null"
  }
]

Attribution in "content" (be strict — this is the main quality bar):
- "you" / "your": ONLY for what the human said or clearly committed to in [user] turns. Paraphrase tightly; a short quoted phrase from the user is good when it grounds the item.
- "I" / "my": ONLY for what Marginalia said in [assistant] turns (the assistant in the transcript). Do not invent Marginalia lines.
- "we" / "our": optional for the shared arc when both speakers contributed; still never attribute an assistant-only point to "you".
- If something matters but only Marginalia said it, write it as Marginalia's side (e.g. "Marginalia suggested …" or "I noted …") — not as something "you" said.
- Do not use "you" for summaries of the assistant's reasoning, hypotheses, or literary analysis unless the user echoed or adopted them in [user].

Other rules:
- Only extract what is clearly evidenced — no inference beyond the transcript.
- Scope discipline:
  - book scope is the default. Use it for anything tied to this book's content, characters, arguments, or the reader's engagement with them.
  - global scope has a high bar: only explicit reader statements that clearly generalize beyond any single book.
  - when in doubt, use book scope or skip the item.
- book_insight / book_question / book_reaction are always scope: book or passage.
- reading_identity / intellectual / preference / emotional can be scope: global, but only under the high bar above.
- confidence: 0.5 for a single observation, 0.7 if strongly stated, 0.9 only for explicit [user] statements`;

  const userPrompt = "Output only the JSON array of memory items.";
  try {
    const data = await invoke<{ answer: string }>("ask_claude_thread_proxy", {
      request: {
        apiKey,
        model: COMPACTION_MODEL,
        systemBlocks: [{ text: systemPrompt, cache_control: undefined }],
        messages: [{ role: "user", content: userPrompt }],
      },
    });
    const raw = (data.answer ?? "").trim();
    const json = raw.replace(/^```\w*\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn("[extractMemoryItems] Response was not a JSON array");
      return [];
    }
    const items: ExtractedMemoryItem[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && typeof (entry as { content?: unknown }).content === "string") {
        const o = entry as { content: string; type?: string; confidence?: number; scope?: string; passage_text?: string | null };
        items.push({
          content: o.content,
          type: typeof o.type === "string" ? o.type : "book_insight",
          confidence: typeof o.confidence === "number" ? o.confidence : 0.5,
          scope: o.scope === "global" || o.scope === "book" || o.scope === "passage" ? o.scope : "book",
          passage_text: o.passage_text != null && typeof o.passage_text === "string" ? o.passage_text : null,
        });
      }
    }
    return items
      .map((i) => ({ ...i, content: i.content.trim() }))
      .filter((i) => {
        const words = countWords(i.content);
        return words >= MEMORY_ITEM_ARCHIVE_MIN_WORDS && words <= MEMORY_ITEM_ARCHIVE_MAX_WORDS;
      })
      .slice(0, 6);
  } catch (e) {
    console.warn("[extractMemoryItems] Parse or API error:", e);
    return [];
  }
}

/** Mid-thread flush: partial extraction, high-confidence only. Same shape as extractMemoryItems; no journal writes. */
export async function extractMemoryItemsPartial(params: {
  thread: Thread;
  messages: ThreadMessage[];
  bookId: string;
  bookTitle: string;
  author: string;
  apiKey: string;
}): Promise<ExtractedMemoryItem[]> {
  const { thread, messages, bookTitle, author, apiKey } = params;
  const threadBlock = formatThreadForPrompt(messages);
  const systemPrompt = `You are extracting structured memory from a reading discussion (partial read).

Book: ${bookTitle} by ${author}
Thread: ${thread.title ?? "Discussion"}

The transcript uses [user] for the human reader and [assistant] for Marginalia. Treat them as two speakers.

${threadBlock}

Only extract items with confidence >= 0.7.
This is a partial read — be conservative. Prefer verbatim or near-verbatim [user] contributions.

Extract 1–3 discrete memory items. Focus on explicit [user] opinions, questions, and preferences.

Return ONLY a JSON array. No preamble, no markdown fences.

[
  {
    "content": "one factual sentence with correct attribution (same rules as full extraction)",
    "type": "reading_identity|intellectual|emotional|preference|book_insight|book_question|book_reaction",
    "confidence": 0.7,
    "scope": "global|book|passage",
    "passage_text": "exact quote if passage-specific, otherwise null"
  }
]

Attribution in "content":
- "you" / "your": ONLY for [user] turns. Short user quotes welcome.
- "I" / "my": ONLY for [assistant] (Marginalia) turns.
- "we" optional when both sides contributed; never assign assistant-only ideas to "you".

Other rules:
- Only include what is clearly evidenced — no inference beyond what's said
- confidence: 0.7 minimum; 0.9 only for explicit [user] statements`;

  const userPrompt = "Output only the JSON array of memory items.";
  try {
    const data = await invoke<{ answer: string }>("ask_claude_thread_proxy", {
      request: {
        apiKey,
        model: COMPACTION_MODEL,
        systemBlocks: [{ text: systemPrompt, cache_control: undefined }],
        messages: [{ role: "user", content: userPrompt }],
      },
    });
    const raw = (data.answer ?? "").trim();
    const json = raw.replace(/^```\w*\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn("[extractMemoryItemsPartial] Response was not a JSON array");
      return [];
    }
    const items: ExtractedMemoryItem[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && typeof (entry as { content?: unknown }).content === "string") {
        const o = entry as { content: string; type?: string; confidence?: number; scope?: string; passage_text?: string | null };
        const confidence = typeof o.confidence === "number" ? o.confidence : 0.7;
        if (confidence < 0.7) continue;
        items.push({
          content: o.content,
          type: typeof o.type === "string" ? o.type : "book_insight",
          confidence,
          scope: o.scope === "global" || o.scope === "book" || o.scope === "passage" ? o.scope : "book",
          passage_text: o.passage_text != null && typeof o.passage_text === "string" ? o.passage_text : null,
        });
      }
    }
    return items;
  } catch (e) {
    console.warn("[extractMemoryItemsPartial] Parse or API error:", e);
    return [];
  }
}

/** Persist extracted items: reinforce existing near-duplicate or save new with anchors. Fire-and-forget. */
export async function persistExtractedMemoryItems(params: {
  items: ExtractedMemoryItem[];
  threadId: string;
  bookId: string;
  attachedHighlights: Highlight[];
}): Promise<void> {
  const { items, threadId, bookId, attachedHighlights } = params;
  if (items.length === 0) return;
  const [bookItems, globalItems] = await Promise.all([
    memoryGetItemsForBook(bookId),
    memoryGetItemsGlobal(),
  ]);
  const existing = [...bookItems, ...globalItems];
  for (const item of items) {
    const match = existing.find((e) => isNearDuplicate(e.content, item.content));
    if (match) {
      try {
        await memoryReinforceItem(match.id);
      } catch (e) {
        console.warn("[persistExtractedMemoryItems] reinforce failed:", e);
      }
      continue;
    }
    // Global scope: anchor with threadId only (no bookId) so item appears in memory_get_items_global.
    const isGlobal = item.scope === "global";
    const anchors: MemoryAnchorInput[] = [
      isGlobal ? { threadId } : { threadId, bookId },
    ];
    if (!isGlobal && (item.scope === "book" || item.scope === "passage") && item.passage_text?.trim()) {
      const passageNorm = normalizeForSimilarity(item.passage_text);
      const highlight = attachedHighlights.find((h) => {
        const hNorm = normalizeForSimilarity(h.selectedText);
        return hNorm === passageNorm || isNearDuplicate(h.selectedText, item.passage_text!, 0.9);
      });
      if (highlight) {
        anchors[0].highlightId = highlight.id;
        anchors[0].cfi = highlight.cfi;
        anchors[0].passageText = item.passage_text;
      } else {
        anchors[0].passageText = item.passage_text;
      }
    }
    const type = [
      "reading_identity",
      "intellectual",
      "emotional",
      "preference",
      "book_insight",
      "book_question",
      "book_reaction",
      "cross_book_pattern",
    ].includes(item.type)
      ? (item.type as MemoryItemInput["type"])
      : "book_insight";
    const memoryItem: MemoryItemInput = {
      content: item.content,
      type,
      confidence: item.confidence,
      source: "compaction",
    };
    try {
      await memorySaveItem(memoryItem, anchors);
    } catch (e) {
      console.warn("[persistExtractedMemoryItems] save failed:", e);
    }
  }
}
