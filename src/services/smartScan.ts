import { invoke } from "@tauri-apps/api/core";
import type { BookDoc, TOCItem } from "@/libs/document";
import {
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

async function callClaudeHaiku(
  systemPrompt: string,
  userMessage: string,
  apiKey: string
): Promise<string> {
  const data = await invoke<{ answer: string }>("ask_claude_thread_proxy", {
    request: {
      apiKey,
      model: "claude-haiku-4-5-20251001",
      systemBlocks: [{ text: systemPrompt }],
      messages: [{ role: "user", content: userMessage }],
      logLabel: "smart_scan",
    },
  });
  return (data.answer ?? "").trim();
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

export async function generateSectionSummary(params: {
  sectionText: string;
  tocLabel: string | null;
  bookTitle: string;
  author: string;
  apiKey: string;
}): Promise<{ structureType: SectionStructureType; entryCount: number | null; summary: string }> {
  const { sectionText, tocLabel, bookTitle, author, apiKey } = params;
  const labelLine = tocLabel ? `This section is titled "${tocLabel}".` : "";
  const systemPrompt = [
    `You are analysing a section of "${bookTitle}" by ${author}.`,
    labelLine,
    "",
    "Return a JSON object with exactly these fields:",
    '  "structureType": one of "narrative" | "journal_entries" | "essay" | "reference" | "prefatory" | "other"',
    '  "entryCount": if structureType is "journal_entries", the number of distinct entries; otherwise null',
    '  "summary": 100-200 words capturing what happens or is argued, key figures or concepts, emotional/intellectual register, and significant turning points — without revealing resolutions that would spoil later reading',
    "",
    "Output only valid JSON. No markdown, no preamble.",
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage = `--- SECTION TEXT ---\n${sectionText}\n--- END SECTION ---`;
  const raw = await callClaudeHaiku(systemPrompt, userMessage, apiKey);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // If JSON parsing fails, treat the whole response as the summary
    return { structureType: "other", entryCount: null, summary: raw.slice(0, 1000) };
  }
  return {
    structureType: parseStructureType(parsed.structureType),
    entryCount:
      typeof parsed.entryCount === "number" ? Math.round(parsed.entryCount) : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

export async function generateBookSummary(params: {
  sectionSummaries: SectionSummary[];
  bookTitle: string;
  author: string;
  apiKey: string;
}): Promise<string> {
  const { sectionSummaries, bookTitle, author, apiKey } = params;
  const systemPrompt = [
    `You are writing a structural overview of "${bookTitle}" by ${author}`,
    "for a reader who is actively reading the book and may not have finished it.",
    "",
    "Write a 200-400 word overview that captures:",
    "- The book's form, structure, and register (what kind of book is this?)",
    "- The central preoccupations, arguments, or narrative threads",
    "- How the book is organised (chronological? thematic? associative?)",
    "- The texture of the writing and what makes it distinctive",
    "",
    "Do not reveal endings, resolutions, or late-book developments.",
    "Describe the book's shape and concerns, not its conclusions.",
    "This will be injected into an AI reading companion's context — write it as reference,",
    "not as a review or recommendation.",
    "Output only the overview. No headers, no preamble.",
  ].join("\n");

  // Pass the full structure manifest so the model can describe patterns across the book
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
  return callClaudeHaiku(systemPrompt, userMessage, apiKey);
}

function flattenToc(items: TOCItem[], map: Map<string, string>) {
  for (const item of items) {
    map.set(item.href.split("#")[0], item.label);
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
  } = params;

  await dbSetBookScanStatus(bookId, "in_progress");
  onScanStatusChange?.("in_progress");

  const tocLabelMap = new Map<string, string>();
  flattenToc(bookDoc.toc ?? [], tocLabelMap);

  const spineItems = (bookDoc.sections ?? []).filter((s) => s.linear !== "no");
  const sectionSummaries: SectionSummary[] = [];
  const bookTitle = metaString(bookDoc.metadata?.title, "Book");
  const author = metaString(bookDoc.metadata?.author, "");

  for (let i = 0; i < spineItems.length; i++) {
    const section = spineItems[i];
    const hrefBase = (section.href ?? "").split("#")[0];
    const tocLabel = tocLabelMap.get(hrefBase) ?? null;

    let sectionText = "";
    try {
      const doc = await section.createDocument();
      sectionText = (doc.body?.innerText ?? "").trim();
    } catch {
      onProgress?.(i + 1, spineItems.length);
      continue;
    }

    if (!sectionText || sectionText.length < 100) {
      onProgress?.(i + 1, spineItems.length);
      continue;
    }

    const truncated = sectionText.slice(0, 60000);
    const { structureType, entryCount, summary } = await generateSectionSummary({
      sectionText: truncated,
      tocLabel,
      bookTitle,
      author,
      apiKey,
    });

    const charCount = sectionText.length;
    // Id must be unique per spine item; multiple spine items can share the same hrefBase (same file, different #fragments).
    // If the EPUB has no href on this spine item (e.g. some foliate-js builds), store a fallback so get_section_text can resolve by index.
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
    sectionSummaries.push(entry);
    onSectionSummaryAdded?.(entry);
    onProgress?.(i + 1, spineItems.length);
    await new Promise((r) => setTimeout(r, 200));
  }

  if (sectionSummaries.length > 0) {
    const bookStructureType = inferBookStructureType(sectionSummaries);
    await dbSetBookStructureType(bookId, bookStructureType);
    onBookStructureTypeSet?.(bookStructureType);
    const bookSummary = await generateBookSummary({
      sectionSummaries,
      bookTitle,
      author,
      apiKey,
    });
    await dbSetBookSummary(bookId, bookSummary);
    onBookSummarySet?.(bookSummary);
  }

  await dbSetBookScanStatus(bookId, "done");
  onScanStatusChange?.("done");
}
