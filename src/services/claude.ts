import { invoke } from "@tauri-apps/api/core";
import type { Highlight, ThreadMessage } from "@/types/book";

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
  currentPassage: string;
  userMessage: string;
  bookTitle: string;
  author: string;
  bookId: string;
  bookMemory?: string | null;
  readerProfile?: string | null;
}

export interface AssembledThreadRequest {
  systemBlocks: Array<{ text: string; cacheControl?: "ephemeral" }>;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEEP_ANALYSIS_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROMPT = "Explain this passage in context.";

function buildSystemPrompt(bookTitle: string, author: string): string {
  return [
    `You are a reading assistant embedded in an ebook reader. The user is reading "${bookTitle}" by "${author}".`,
    "Answer questions about the text concisely and accurately. Ground your answers in the book's content.",
    "Do not summarize the entire book unless asked. Be conversational, not academic.", "You need not ask questions all the time to the user, use questions sparingly."
  ].join("\n");
}

function chooseModel(userMessage: string): string {
  const query = userMessage.toLowerCase();
  const asksDeepAnalysis =
    query.includes("deep analysis") ||
    query.includes("analyze deeply") ||
    query.includes("in depth") ||
    query.includes("in-depth");
  return asksDeepAnalysis ? DEEP_ANALYSIS_MODEL : DEFAULT_MODEL;
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
  const model = chooseModel(prompt);

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
      systemPrompt: buildSystemPrompt(bookTitle, author),
      surroundingContext,
      selectedText,
      userMessage: prompt,
      conversationHistory,
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

/** Assemble system blocks and messages for thread-aware Claude request (Phase 25). */
export function assembleThreadContext(params: ThreadContextParams): AssembledThreadRequest {
  const {
    bookTitle,
    author,
    readerProfile,
    bookMemory,
    attachedHighlights,
    messages,
    currentPassage,
    userMessage,
  } = params;

  let systemParts: string[] = [
    `You are Marginalia, a reading companion for "${bookTitle}" by ${author}.`,
  ];
  if (readerProfile?.trim()) {
    systemParts.push(`About this reader: ${readerProfile.trim()}`);
  }
  if (bookMemory?.trim()) {
    const trimmed = bookMemory.trim();
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount <= 500) {
      systemParts.push(`Reading history for this book:\n${trimmed}`);
    } else {
      const entries = trimmed.split(/\n## /);
      const recent = entries.slice(-3);
      systemParts.push(
        `Reading history for this book (recent entries):\n## ${recent.join("\n## ")}`
      );
      systemParts.push(
        `You have ${Math.max(0, entries.length - 3)} prior journal entries for this book.`
      );
    }
  }
  systemParts.push(
    "Your default state is the selected passage and the reader's question. Do not assume knowledge of the broader book beyond what you are given. Explore only what the context warrants. You'll be given the chapter text and the highlighted sections by the user.\ Only answer questions as if you've only read up to the same point as the user (unless explicitly asked for by the user)"
  );
  const systemBlock: AssembledThreadRequest["systemBlocks"][0] = {
    text: systemParts.join("\n\n"),
    cacheControl: "ephemeral",
  };

  const chapterText = currentPassage.trim().slice(0, 16000);
  const highlightedSections =
    attachedHighlights.length > 0
      ? attachedHighlights
          .map(
            (h) =>
              `[${h.chapterLabel ?? "Chapter"}]\n${h.selectedText}`
          )
          .join("\n\n---\n\n")
      : "(No highlights in this thread)";
  const chapterAndHighlightsBlock = `Here's the chapter's text:\n\n${chapterText || "(No chapter text available.)"}\n\nHere's the highlighted section(s) by the user:\n\n${highlightedSections}`;

  const historyMessages: AssembledThreadRequest["messages"] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const currentTurn: AssembledThreadRequest["messages"][0] = {
    role: "user",
    content: userMessage,
  };

  return {
    systemBlocks: [
      systemBlock,
      { text: chapterAndHighlightsBlock, cacheControl: "ephemeral" },
    ],
    messages: [...historyMessages, currentTurn],
  };
}

export async function askClaudeThread(
  params: ThreadContextParams,
  apiKey: string
): Promise<ClaudeResponse> {
  const assembled = assembleThreadContext(params);
  const model = chooseModel(params.userMessage);
  const request = {
    apiKey,
    model,
    systemBlocks: assembled.systemBlocks.map((b) => ({
      text: b.text,
      cache_control: b.cacheControl ?? undefined,
    })),
    messages: assembled.messages,
  };
  const data = await invoke<{
    answer: string;
    model: string;
    usage?: ClaudeResponse["usage"];
  }>("ask_claude_thread_proxy", { request });
  const answer = data.answer ?? "";
  if (data.usage) {
    console.log("[Claude thread usage]", data.usage);
  }
  return {
    answer,
    model: data.model ?? model,
    usage: data.usage,
  };
}
