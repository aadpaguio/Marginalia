import { invoke } from "@tauri-apps/api/core";
import type { BookDoc, TOCItem } from "@/libs/document";
import { isRateLimitError, withAnthropicRateLimitRetry } from "@/services/anthropicRateLimit";
import {
  dbGetSectionSummaries,
  dbSetBookScanStatus,
  dbSetBookSummary,
  dbSetBookStructureType,
  dbUpsertSectionSummary,
  type SectionSummary,
  type SectionStructureType,
} from "@/services/db";

/** Inferred from section structure types for structure-map rendering (e.g. linear list for narrative). */
export type BookStructureType = "essays" | "narrative" | "journal_entries" | "other";

function inferBookStructureType(summaries: SectionSummary[]): BookStructureType {
  if (summaries.length === 0) return "other";
  const counts: Record<string, number> = {};
  for (const s of summaries) {
    const t = s.structureType;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  const total = summaries.length;
  if ((counts["essay"] ?? 0) / total >= 0.4) return "essays";
  if ((counts["narrative"] ?? 0) / total >= 0.4) return "narrative";
  if ((counts["journal_entries"] ?? 0) / total >= 0.3) return "journal_entries";
  return "other";
}

function metaString(val: unknown, fallback: string): string {
  if (typeof val === "string") return val.trim() || fallback;
  if (Array.isArray(val) && val.length > 0) return String(val[0]).trim() || fallback;
  return fallback;
}

/** Extract author from foliate-js metadata (author can be array of { name: string | Record<lang,string> }). */
function metaAuthor(meta: { author?: unknown } | null | undefined, fallback: string): string {
  const a = meta?.author;
  if (typeof a === "string") return a.trim() || fallback;
  if (Array.isArray(a) && a.length > 0) {
    const first = a[0];
    if (first && typeof first === "object" && "name" in first) {
      const name = (first as { name?: unknown }).name;
      if (typeof name === "string") return name.trim() || fallback;
      if (name && typeof name === "object" && !Array.isArray(name)) {
        const v = Object.values(name).find((x): x is string => typeof x === "string");
        return (v?.trim() ?? "") || fallback;
      }
    }
  }
  return fallback;
}

/** ~3k tokens input; keeps under 50k/min with many sections. */
const SECTION_CHAR_BUDGET = 12_000;
const SECTION_MAX_TOKENS = 550;
const BOOK_SUMMARY_MAX_TOKENS = 1_000;
const TOKEN_WINDOW_MS = 60_000;
const MAX_TOKENS_PER_WINDOW = 50_000;
const SCAN_CONCURRENCY = 3;

/** Proactive rate limiter: track tokens in last 60s, wait before sending if we'd exceed 50k/min. */
class TokenLimiter {
  private entries: { at: number; tokens: number }[] = [];

  private trim(): void {
    const cutoff = Date.now() - TOKEN_WINDOW_MS;
    this.entries = this.entries.filter((e) => e.at > cutoff);
  }

  /** Wait until we can send estimatedTokens without exceeding the window. */
  async acquire(estimatedTokens: number): Promise<void> {
    for (;;) {
      this.trim();
      const used = this.entries.reduce((s, e) => s + e.tokens, 0);
      if (used + estimatedTokens <= MAX_TOKENS_PER_WINDOW) return;
      const oldest = this.entries[0];
      const waitMs = oldest ? Math.min(TOKEN_WINDOW_MS, oldest.at + TOKEN_WINDOW_MS - Date.now()) : TOKEN_WINDOW_MS;
      if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 5000)));
    }
  }

  /** Record usage from a completed request (input + output). */
  record(usage: { inputTokens?: number; outputTokens?: number }): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    if (input + output === 0) return;
    this.entries.push({ at: Date.now(), tokens: input + output });
  }
}

/** Proxy response includes usage for limiter (camelCase from Rust). */
interface ProxyUsage {
  inputTokens?: number;
  outputTokens?: number;
}

async function callClaudeHaiku(params: {
  systemBlocks: { text: string; cacheControl?: "ephemeral" }[];
  userMessage: string;
  apiKey: string;
  maxTokens: number;
}): Promise<{ answer: string; usage?: ProxyUsage }> {
  const data = await invoke<{ answer: string; usage?: ProxyUsage }>("ask_claude_thread_proxy", {
    request: {
      apiKey: params.apiKey,
      model: "claude-haiku-4-5-20251001",
      systemBlocks: params.systemBlocks.map((b) => ({
        text: b.text,
        cacheControl: b.cacheControl,
      })),
      messages: [{ role: "user", content: params.userMessage }],
      logLabel: "smart_scan",
      maxTokens: params.maxTokens,
    },
  });
  return {
    answer: (data.answer ?? "").trim(),
    usage: data.usage,
  };
}

async function callClaudeHaikuWithRetry(params: {
  systemBlocks: { text: string; cacheControl?: "ephemeral" }[];
  userMessage: string;
  apiKey: string;
  maxTokens: number;
  onRateLimitWait?: (secondsLeft: number) => void;
}): Promise<{ answer: string; usage?: ProxyUsage }> {
  const { systemBlocks, userMessage, apiKey, maxTokens, onRateLimitWait } = params;
  return withAnthropicRateLimitRetry(
    () => callClaudeHaiku({ systemBlocks, userMessage, apiKey, maxTokens }),
    { onRateLimitWait }
  );
}

function computeRadiusGuide(charCount: number): SectionSummary["radiusGuide"] {
  return {
    snippet: Math.min(1500, Math.floor(charCount * 0.1)),
    section: Math.min(8000, Math.floor(charCount * 0.4)),
    full: Math.floor(charCount / 2),
  };
}

const VALID_STRUCTURE_TYPES: SectionStructureType[] = [
  "narrative",
  "journal_entries",
  "essay",
  "reference",
  "prefatory",
  "other",
];

function parseStructureType(val: unknown): SectionStructureType {
  if (typeof val === "string" && VALID_STRUCTURE_TYPES.includes(val as SectionStructureType)) {
    return val as SectionStructureType;
  }
  return "other";
}

/** Static instructions for section summary (cached). */
const SECTION_SUMMARY_STATIC_SYSTEM =
  "Return a JSON object with exactly these fields:\n" +
  '  "structureType": one of "narrative" | "journal_entries" | "essay" | "reference" | "prefatory" | "other"\n' +
  '  "entryCount": if structureType is "journal_entries", the number of distinct entries; otherwise null\n' +
  '  "summary": 100-200 words capturing what happens or is argued, key figures or concepts, emotional/intellectual register, and significant turning points — without revealing resolutions that would spoil later reading\n\n' +
  "Output only valid JSON. No markdown, no preamble.";

export async function generateSectionSummary(params: {
  sectionText: string;
  tocLabel: string | null;
  bookTitle: string;
  author: string;
  apiKey: string;
  onRateLimitWait?: (secondsLeft: number) => void;
  limiter?: TokenLimiter;
}): Promise<{ structureType: SectionStructureType; entryCount: number | null; summary: string }> {
  const { sectionText, tocLabel, bookTitle, author, apiKey, onRateLimitWait, limiter } = params;
  const dynamicLine = `You are analysing a section of "${bookTitle}" by ${author}.${tocLabel ? ` This section is titled "${tocLabel}".` : ""}`;
  const systemBlocks: { text: string; cacheControl?: "ephemeral" }[] = [
    { text: SECTION_SUMMARY_STATIC_SYSTEM, cacheControl: "ephemeral" },
    { text: dynamicLine },
  ];
  const userMessage = `--- SECTION TEXT ---\n${sectionText}\n--- END SECTION ---`;
  const estimatedTokens = Math.ceil((SECTION_SUMMARY_STATIC_SYSTEM.length + dynamicLine.length + userMessage.length) / 4) + SECTION_MAX_TOKENS;
  if (limiter) await limiter.acquire(estimatedTokens);
  const { answer: raw, usage } = await callClaudeHaikuWithRetry({
    systemBlocks,
    userMessage,
    apiKey,
    maxTokens: SECTION_MAX_TOKENS,
    onRateLimitWait,
  });
  if (limiter && usage) limiter.record(usage);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return { structureType: "other", entryCount: null, summary: raw.slice(0, 1000) };
  }
  return {
    structureType: parseStructureType(parsed.structureType),
    entryCount:
      typeof parsed.entryCount === "number" ? Math.round(parsed.entryCount) : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

/** Static instructions for book overview (cached). */
const BOOK_SUMMARY_STATIC_SYSTEM =
  "You are writing a structural overview for a reader who is actively reading the book and may not have finished it.\n\n" +
  "Write a 200-400 word overview that captures:\n" +
  "- The book's form, structure, and register (what kind of book is this?)\n" +
  "- The central preoccupations, arguments, or narrative threads\n" +
  "- How the book is organised (chronological? thematic? associative?)\n" +
  "- The texture of the writing and what makes it distinctive\n\n" +
  "Do not reveal endings, resolutions, or late-book developments.\n" +
  "Describe the book's shape and concerns, not its conclusions.\n" +
  "This will be injected into an AI reading companion's context — write it as reference, not as a review or recommendation.\n" +
  "Output only the overview. No headers, no preamble.";

export async function generateBookSummary(params: {
  sectionSummaries: SectionSummary[];
  bookTitle: string;
  author: string;
  apiKey: string;
  onRateLimitWait?: (secondsLeft: number) => void;
}): Promise<string> {
  const { sectionSummaries, bookTitle, author, apiKey, onRateLimitWait } = params;
  const dynamicLine = `You are writing a structural overview of "${bookTitle}" by ${author}.`;
  const systemBlocks: { text: string; cacheControl?: "ephemeral" }[] = [
    { text: BOOK_SUMMARY_STATIC_SYSTEM, cacheControl: "ephemeral" },
    { text: dynamicLine },
  ];
  const manifest = sectionSummaries
    .map((s) => {
      const typeTag =
        s.structureType === "journal_entries" && s.entryCount != null
          ? `${s.structureType} · ${s.entryCount} entries`
          : s.structureType;
      const label = s.tocLabel ?? s.spineHref;
      return `${label} [${typeTag} · ~${s.estimatedTokens.toLocaleString()} tokens]:\n${s.summary}`;
    })
    .join("\n\n");
  const userMessage = `--- SECTION MANIFEST ---\n${manifest}\n--- END MANIFEST ---`;
  const { answer } = await callClaudeHaikuWithRetry({
    systemBlocks,
    userMessage,
    apiKey,
    maxTokens: BOOK_SUMMARY_MAX_TOKENS,
    onRateLimitWait,
  });
  return answer;
}

/** Normalize href for TOC/spine matching: strip fragment, leading ./, trim. */
function normalizeHref(href: string): string {
  return href.split("#")[0].replace(/^\.\//, "").trim() || "";
}

function flattenToc(items: TOCItem[], map: Map<string, string>) {
  for (const item of items) {
    const key = normalizeHref(item.href);
    if (key) map.set(key, item.label);
    if (item.subitems) flattenToc(item.subitems, map);
  }
}

export async function runSmartScan(params: {
  bookId: string;
  bookDoc: BookDoc;
  apiKey: string;
  onProgress?: (done: number, total: number) => void;
  onScanStatusChange?: (status: "none" | "in_progress" | "done") => void;
  onSectionSummaryAdded?: (summary: SectionSummary) => void;
  onBookSummarySet?: (summary: string) => void;
  onBookStructureTypeSet?: (type: BookStructureType) => void;
  onRateLimitWait?: (secondsLeft: number) => void;
}): Promise<void> {
  const {
    bookId,
    bookDoc,
    apiKey,
    onProgress,
    onScanStatusChange,
    onSectionSummaryAdded,
    onBookSummarySet,
    onBookStructureTypeSet,
    onRateLimitWait,
  } = params;

  await dbSetBookScanStatus(bookId, "in_progress");
  onScanStatusChange?.("in_progress");

  const tocLabelMap = new Map<string, string>();
  flattenToc(bookDoc.toc ?? [], tocLabelMap);
  /** Fallback: map path tail (e.g. "chapter1.xhtml") to label when full path doesn't match. */
  const tocByTail = new Map<string, string>();
  for (const [path, label] of tocLabelMap) {
    const tail = path.replace(/^.*\//, "");
    if (tail && !tocByTail.has(tail)) tocByTail.set(tail, label);
  }

  const spineItems = (bookDoc.sections ?? []).filter((s) => s.linear !== "no");
  const existingSummaries = await dbGetSectionSummaries(bookId);
  const existingByIndex = new Map(existingSummaries.map((s) => [s.spineIndex, s]));
  const results = new Map<number, SectionSummary>();
  const limiter = new TokenLimiter();
  const bookTitle = metaString(bookDoc.metadata?.title, "Book");
  const author = metaAuthor(bookDoc.metadata, "");

  for (const s of existingSummaries) {
    onSectionSummaryAdded?.(s);
  }
  if (existingSummaries.length > 0) {
    onProgress?.(existingSummaries.length, spineItems.length);
  }

  const pendingIndices = spineItems
    .map((_, i) => i)
    .filter((i) => !existingByIndex.has(i));

  let concurrent = 0;
  const withSlot = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const run = async () => {
        while (concurrent >= SCAN_CONCURRENCY) await new Promise((r) => setTimeout(r, 50));
        concurrent++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          concurrent--;
        }
      };
      void run();
    });

  const processSection = async (i: number): Promise<void> => {
    const section = spineItems[i];
    // foliate-js exposes the spine document path as section.id (not href); prefer id for TOC lookup
    const hrefBase = normalizeHref(section.href ?? section.id ?? "");
    const hrefTail = hrefBase.replace(/^.*\//, "");
    const tocLabel =
      tocLabelMap.get(hrefBase) ?? (hrefTail ? (tocByTail.get(hrefTail) ?? null) : null);
    let sectionText = "";
    try {
      const doc = await section.createDocument();
      sectionText = (doc.body?.innerText ?? "").trim();
    } catch {
      return;
    }
    if (!sectionText || sectionText.length < 100) {
      return;
    }
    const truncated = sectionText.slice(0, SECTION_CHAR_BUDGET);
    let structureType: SectionStructureType;
    let entryCount: number | null;
    let summary: string;
    try {
      const result = await generateSectionSummary({
        sectionText: truncated,
        tocLabel,
        bookTitle,
        author,
        apiKey,
        onRateLimitWait,
        limiter,
      });
      structureType = result.structureType;
      entryCount = result.entryCount;
      summary = result.summary;
    } catch (e) {
      if (isRateLimitError(e)) {
        await dbSetBookScanStatus(bookId, "none");
        onScanStatusChange?.("none");
      }
      throw e;
    }
    const charCount = sectionText.length;
    const spineHref = hrefBase.trim() || `spine-${i}`;
    const entry: SectionSummary = {
      id: `${bookId}-spine-${i}`,
      bookId,
      spineHref,
      spineIndex: i,
      tocLabel,
      charCount,
      estimatedTokens: Math.round(charCount / 4),
      structureType,
      entryCount,
      summary,
      radiusGuide: computeRadiusGuide(charCount),
      createdAt: Date.now(),
    };
    await dbUpsertSectionSummary(entry);
    results.set(i, entry);
    onSectionSummaryAdded?.(entry);
    onProgress?.(existingByIndex.size + results.size, spineItems.length);
  };

  await Promise.all(
    pendingIndices.map((i) => withSlot(() => processSection(i)))
  );

  const sectionSummaries = Array.from(
    { length: spineItems.length },
    (_, i) => existingByIndex.get(i) ?? results.get(i)
  ).filter((x): x is SectionSummary => x != null);

  if (sectionSummaries.length > 0) {
    const bookStructureType = inferBookStructureType(sectionSummaries);
    await dbSetBookStructureType(bookId, bookStructureType);
    onBookStructureTypeSet?.(bookStructureType);
    try {
      const bookSummary = await generateBookSummary({
        sectionSummaries,
        bookTitle,
        author,
        apiKey,
        onRateLimitWait,
      });
      await dbSetBookSummary(bookId, bookSummary);
      onBookSummarySet?.(bookSummary);
    } catch (e) {
      if (isRateLimitError(e)) {
        await dbSetBookScanStatus(bookId, "none");
        onScanStatusChange?.("none");
      }
      throw e;
    }
  }

  await dbSetBookScanStatus(bookId, "done");
  onScanStatusChange?.("done");
}
