/**
 * Phase 26: Book memory compaction and reader profile extraction.
 * Uses Haiku for summarization; memory files are plain Markdown.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ThreadMessage } from "@/types/book";

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
