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

function getApiKey(): string {
  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("Missing VITE_ANTHROPIC_API_KEY for compaction");
  }
  return key;
}

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

/** Returns the new journal entry (150–250 words) to append. */
export async function compactThreadToJournal(params: {
  bookTitle: string;
  author: string;
  threadTitle: string;
  threadDate: string;
  threadMessages: ThreadMessage[];
  existingMemory?: string | null;
}): Promise<string> {
  const {
    bookTitle,
    author,
    threadTitle,
    threadDate,
    threadMessages,
    existingMemory,
  } = params;
  const threadBlock = formatThreadForPrompt(threadMessages);
  const existingBlock =
    existingMemory?.trim()
      ? `--- EXISTING JOURNAL ---\n${existingMemory.trim()}\n--- END JOURNAL ---`
      : "";
  const systemPrompt = `You are updating the reading journal for a book.
Book: ${bookTitle} by ${author}
Thread title: ${threadTitle}
Thread date: ${threadDate}

--- THREAD ---
${threadBlock}
--- END THREAD ---

${existingBlock ? `${existingBlock}\n\nIntegrate this thread's insights into the existing journal. Do not repeat what's already there. Extend it.` : ""}

Write a reading journal entry. Refer to yourself as I and the user as "you". 50-100 words. Include:
- Specific chapter/section/page number if known (e.g. 'Chapter 3, page 10').
- The central question or passage that sparked the thread
- Key insight or connection that emerged
- Any unresolved question worth returning to
- A theme or motif that appeared

Do not include: small talk, meta-commentary about the AI, verbatim quotes longer than one sentence.

Emphasis on Brevity.

Output only the journal content. No headers, no preamble.`;
  const userPrompt = "Generate the journal entry.";
  const apiKey = getApiKey();
  const data = await invoke<{ answer: string }>("ask_claude_thread_proxy", {
    request: {
      apiKey,
      model: COMPACTION_MODEL,
      systemBlocks: [{ text: systemPrompt, cache_control: undefined }],
      messages: [{ role: "user", content: userPrompt }],
    },
  });
  return (data.answer ?? "").trim();
}

/** Returns the new reader profile (100–150 words). */
export async function extractReaderProfile(params: {
  journalsByTitle: Array<{ title: string; content: string }>;
  existingProfile?: string | null;
}): Promise<string> {
  const { journalsByTitle, existingProfile } = params;
  const journalsBlock = journalsByTitle
    .map((j) => `## ${j.title}\n${j.content}`)
    .join("\n\n");
  const existingBlock = existingProfile?.trim()
    ? `--- EXISTING PROFILE ---\n${existingProfile.trim()}\n--- END PROFILE ---`
    : "";
  const systemPrompt = `You are building a reader profile from a person's reading journal entries across multiple books.

--- JOURNALS ---
${journalsBlock}
--- END JOURNALS ---

${existingBlock ? `${existingBlock}\n\n` : ""}

Write a concise reader profile (100-150 words) in second person. Capture:
- Recurring intellectual interests and themes across books
- How this reader engages with texts (close reading? thematic? philosophical?)
- Preferred depth and style of explanation
- Any notable patterns in what they highlight or question

Rewrite the profile entirely — don't append. This is a living document, not a log.
Output only the profile. No headers.`;
  const userPrompt = "Generate the reader profile.";
  const apiKey = getApiKey();
  const data = await invoke<{ answer: string }>("ask_claude_thread_proxy", {
    request: {
      apiKey,
      model: COMPACTION_MODEL,
      systemBlocks: [{ text: systemPrompt, cache_control: undefined }],
      messages: [{ role: "user", content: userPrompt }],
    },
  });
  return (data.answer ?? "").trim();
}

const READER_FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const THREADS_CLOSED_REGEX = /threads_closed:\s*(\d+)/;
const LAST_PROFILE_REGEX = /last_profile_update:\s*([^\s\n]+)/;

export function parseReaderMd(content: string): { threadsClosed: number; lastProfileUpdate: string; body: string } {
  const match = content.match(READER_FRONTMATTER_REGEX);
  if (!match) {
    return { threadsClosed: 0, lastProfileUpdate: "", body: content };
  }
  const [, front, body] = match;
  const threadsClosed = parseInt(front.match(THREADS_CLOSED_REGEX)?.[1] ?? "0", 10);
  const lastProfileUpdate = front.match(LAST_PROFILE_REGEX)?.[1] ?? "";
  return { threadsClosed, lastProfileUpdate, body: body.trim() };
}

export function formatReaderMd(params: { threadsClosed: number; body: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  return `---
threads_closed: ${params.threadsClosed}
last_profile_update: ${date}
---

${params.body}`;
}

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

/** Extract 2–5 discrete memory items from a thread via Haiku. Returns empty array on parse failure. */
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

${threadBlock}

Extract 2–5 discrete memory items worth remembering about this reader.
Focus on: what they found surprising, opinions they formed, questions that excited them, intellectual patterns, emotional reactions to the text.

Return ONLY a JSON array. No preamble, no markdown fences.

[
  {
    "content": "single insight in second person, one sentence",
    "type": "reading_identity|intellectual|emotional|preference|book_insight|book_question|book_reaction",
    "confidence": 0.5,
    "scope": "global|book|passage",
    "passage_text": "exact quote if passage-specific, otherwise null"
  }
]

Rules:
- content must be second person ("You tend to...", "You were struck by...")
- Only extract what is clearly evidenced in the thread — no inference beyond what's said
- book_insight / book_question / book_reaction are always scope: book or passage
- reading_identity / intellectual / preference / emotional can be scope: global
- confidence: 0.5 for a single observation, 0.7 if strongly stated, 0.9 only for explicit user statements`;

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
    return items;
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

${threadBlock}

Only extract items with confidence >= 0.7.
This is a partial read — be conservative.
Prefer explicit reader statements over inferences.

Extract 1–3 discrete memory items worth remembering. Focus on: explicit opinions, clear questions, stated preferences.

Return ONLY a JSON array. No preamble, no markdown fences.

[
  {
    "content": "single insight in second person, one sentence",
    "type": "reading_identity|intellectual|emotional|preference|book_insight|book_question|book_reaction",
    "confidence": 0.7,
    "scope": "global|book|passage",
    "passage_text": "exact quote if passage-specific, otherwise null"
  }
]

Rules:
- content must be second person ("You tend to...", "You said...")
- Only include what is clearly evidenced — no inference beyond what's said
- confidence: 0.7 minimum; 0.9 only for explicit user statements`;

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

/** Phase 30.1: Consolidate book memory when it exceeds ~600 words. Rewrites file to Reading Summary + Recent Threads. */
export async function consolidateBookMemory(params: {
  bookId: string;
  bookTitle: string;
  author: string;
  currentMemory: string;
  apiKey: string;
}): Promise<string> {
  const { bookTitle, author, currentMemory, apiKey } = params;
  const systemPrompt = `You are maintaining a reading journal for a book.
Below is the accumulated journal for: ${bookTitle} by ${author}

${currentMemory}

Rewrite this into two sections:
1. "## Reading Summary" — a ~150 word synthesis in second person ("You have been exploring...") covering the main themes, questions, insights, and unresolved threads across all reading sessions. This is the durable record.
2. "## Recent Threads" — copy the two most recent ## sections verbatim, unchanged.

Output only the two sections. No preamble.`;

  const userPrompt = "Output the two sections.";
  const data = await invoke<{ answer: string }>("ask_claude_thread_proxy", {
    request: {
      apiKey,
      model: COMPACTION_MODEL,
      systemBlocks: [{ text: systemPrompt, cache_control: undefined }],
      messages: [{ role: "user", content: userPrompt }],
    },
  });
  return (data.answer ?? "").trim();
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
