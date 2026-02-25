import { invoke } from "@tauri-apps/api/core";

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

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEEP_ANALYSIS_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROMPT = "Explain this passage in context.";

function buildSystemPrompt(bookTitle: string, author: string): string {
  return [
    `You are a reading assistant embedded in an ebook reader. The user is reading "${bookTitle}" by "${author}".`,
    "Answer questions about the text concisely and accurately. Ground your answers in the book's content.",
    "Do not summarize the entire book unless asked. Be conversational, not academic.",
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
