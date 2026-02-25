import { useEffect, useMemo, useRef, useState } from "react";
import { askClaude } from "@/services/claude";
import type { BookNote } from "@/types/book";
import type { AIPanelSelection } from "@/app/reader/hooks/useAIPanel";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  selection: AIPanelSelection | null;
  bookTitle: string;
  author: string;
  getContext: (cfi: string) => string;
  onSave: (note: BookNote) => void;
  onDismiss: () => void;
};

type ChatMessage = { role: "user" | "assistant"; content: string };

const MISSING_KEY_DISMISS_FLAG = "marginalia:missing-anthropic-key-dismissed";

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toFriendlyErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("credit balance is too low")) {
    return "Add credits to continue.";
  }
  return message;
}

export default function AIPanel({
  selection,
  bookTitle,
  author,
  getContext,
  onSave,
  onDismiss,
}: Props) {
  const [isVisible, setIsVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [frozenContext, setFrozenContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastUsage, setLastUsage] = useState<{
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  } | null>(null);
  const [dismissedMissingKeyPrompt, setDismissedMissingKeyPrompt] = useState(
    () => localStorage.getItem(MISSING_KEY_DISMISS_FLAG) === "1"
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const revealTimerRef = useRef<number | null>(null);

  const isMissingApiKey = !import.meta.env.VITE_ANTHROPIC_API_KEY;

  useEffect(() => {
    let raf = 0;
    setIsVisible(false);
    raf = window.requestAnimationFrame(() => setIsVisible(true));
    return () => window.cancelAnimationFrame(raf);
  }, [selection?.cfi]);

  useEffect(() => {
    setMessage("");
    setMessages([]);
    setLastUsage(null);
    setError(null);
    setIsSaving(false);
    if (selection) {
      setFrozenContext(getContext(selection.cfi));
    } else {
      setFrozenContext("");
    }
    inputRef.current?.focus();
  }, [selection?.cfi, selection?.selectedText, getContext, selection]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    // Keep conversation pinned to latest message instantly.
    el.scrollTop = el.scrollHeight;
  }, [messages, isAsking]);

  useEffect(
    () => () => {
      if (revealTimerRef.current != null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onClickOutside = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (e.target instanceof Node && !panelRef.current.contains(e.target)) {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onEscape);
    window.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [onDismiss]);

  const latestAssistantResponse = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.content.trim().length > 0) return msg.content;
    }
    return "";
  }, [messages]);

  const approxContextTokens = useMemo(() => Math.ceil(frozenContext.length / 4), [frozenContext]);

  const canSave = useMemo(() => {
    const hasAssistantReply = messages.some((m) => m.role === "assistant" && m.content.trim().length > 0);
    return !!selection && hasAssistantReply && !isSaving;
  }, [selection, messages, isSaving]);

  const handleAsk = async () => {
    if (!selection || isAsking) return;
    setError(null);
    setIsAsking(true);
    const submittedMessage = message.trim() || "Explain this passage in context.";
    const priorMessages = messages;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: submittedMessage },
      { role: "assistant", content: "" },
    ]);

    const revealAssistantMessage = (fullText: string) =>
      new Promise<void>((resolve) => {
        if (revealTimerRef.current != null) {
          window.clearTimeout(revealTimerRef.current);
          revealTimerRef.current = null;
        }
        let cursor = 0;
        const minStep = 2;
        const maxFrames = 90;
        const step = Math.max(minStep, Math.ceil(fullText.length / maxFrames));
        const tick = () => {
          cursor = Math.min(fullText.length, cursor + step);
          const partial = fullText.slice(0, cursor);
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i]?.role === "assistant") {
                copy[i] = { ...copy[i], content: partial };
                break;
              }
            }
            return copy;
          });
          if (cursor < fullText.length) {
            revealTimerRef.current = window.setTimeout(tick, 12);
          } else {
            revealTimerRef.current = null;
            resolve();
          }
        };
        tick();
      });

    try {
      const result = await askClaude({
        selectedText: selection.selectedText,
        surroundingContext: frozenContext,
        bookTitle,
        author,
        userMessage: submittedMessage,
        conversationHistory: priorMessages,
      });
      await revealAssistantMessage(result.answer ?? "");
      setLastUsage(result.usage ?? null);
      setMessage("");
    } catch (err) {
      setMessages((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i]?.role === "assistant" && copy[i]?.content === "") {
            copy.splice(i, 1);
            break;
          }
        }
        return copy;
      });
      const nextMessage = err instanceof Error ? err.message : String(err);
      setError(toFriendlyErrorMessage(nextMessage));
    } finally {
      setIsAsking(false);
    }
  };

  const handleSave = () => {
    if (!selection || !canSave) return;
    setIsSaving(true);
    try {
      onSave({
        id: uniqueId(),
        type: "annotation",
        cfi: selection.cfi,
        selectedText: selection.selectedText,
        text: selection.selectedText,
        style: "highlight",
        color: "yellow",
        note: latestAssistantResponse,
        aiConversation: messages.map((m, idx) => ({
          role: m.role,
          content: m.content,
          timestamp: Date.now() + idx,
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      onDismiss();
    } finally {
      setIsSaving(false);
    }
  };

  const dismissMissingKeyPrompt = () => {
    localStorage.setItem(MISSING_KEY_DISMISS_FLAG, "1");
    setDismissedMissingKeyPrompt(true);
  };

  if (!selection) return null;

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 420,
        maxWidth: "92vw",
        zIndex: 120,
        padding: 14,
        borderLeft: "1px solid rgba(0,0,0,0.1)",
        background: "linear-gradient(180deg, rgba(252,252,252,0.98) 0%, rgba(247,247,247,0.98) 100%)",
        backdropFilter: "blur(6px)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? "translateX(0) scale(1)" : "translateX(20px) scale(0.985)",
        transition: "opacity 180ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
        transformOrigin: "right center",
      }}
      role="dialog"
      aria-label="AI panel"
      onClick={(e) => e.stopPropagation()}
      onWheelCapture={(e) => e.stopPropagation()}
      onPointerDownCapture={(e) => e.stopPropagation()}
      onPointerMoveCapture={(e) => e.stopPropagation()}
      onPointerUpCapture={(e) => e.stopPropagation()}
      onTouchStartCapture={(e) => e.stopPropagation()}
      onTouchMoveCapture={(e) => e.stopPropagation()}
      onTouchEndCapture={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingBottom: 8,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
        }}
      >
        <div>
          <strong style={{ fontSize: 14, display: "block" }}>Marginalia AI</strong>
          <span style={{ fontSize: 12, color: "#666" }}>Ask about this passage</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          style={{ cursor: "pointer", borderRadius: 8, border: "1px solid rgba(0,0,0,0.12)" }}
        >
          Close
        </button>
      </div>

      {!dismissedMissingKeyPrompt && isMissingApiKey && (
        <div
          style={{
            fontSize: 12,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid rgba(181, 26, 26, 0.35)",
            background: "rgba(181, 26, 26, 0.08)",
            color: "#7a1515",
          }}
        >
          <div style={{ marginBottom: 6 }}>
            Add <code>VITE_ANTHROPIC_API_KEY</code> to your <code>.env</code>, then restart dev
            server.
          </div>
          <button type="button" onClick={dismissMissingKeyPrompt} style={{ cursor: "pointer" }}>
            Don’t show again
          </button>
        </div>
      )}

      <div
        ref={messagesRef}
        style={{
          flex: 1,
          minHeight: 120,
          overflow: "auto",
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 10,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            alignSelf: "flex-start",
            maxWidth: "90%",
          }}
        >
          <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>Selected passage</div>
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.06)",
              borderLeft: "3px solid #e0d26c",
              fontSize: 13,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              color: "#222",
            }}
          >
            {selection.selectedText || "(No selected text captured)"}
          </div>
        </div>

        {messages.map((msg, idx) => {
          const isUser = msg.role === "user";
          const isAssistantEmpty = msg.role === "assistant" && msg.content.length === 0;
          return (
            <div
              key={`${msg.role}-${idx}-${msg.content.slice(0, 16)}`}
              style={{
                alignSelf: isUser ? "flex-end" : "flex-start",
                maxWidth: "90%",
              }}
            >
              <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>
                {isUser ? "You" : "Claude"}
              </div>
              <div
                style={{
                  padding: "9px 11px",
                  borderRadius: 12,
                  background: isUser ? "#1f6feb" : "rgba(0,0,0,0.06)",
                  color: isUser ? "#fff" : "#222",
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                {isUser ? (
                  <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
                ) : isAssistantEmpty ? (
                  <span style={{ opacity: 0.8 }}>Typing...</span>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: ({ children }) => <p style={{ margin: "0 0 8px" }}>{children}</p>,
                      ul: ({ children }) => <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>{children}</ul>,
                      ol: ({ children }) => <ol style={{ margin: "0 0 8px 18px", padding: 0 }}>{children}</ol>,
                      code: ({ children }) => (
                        <code
                          style={{
                            background: "rgba(0,0,0,0.07)",
                            padding: "1px 4px",
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                        >
                          {children}
                        </code>
                      ),
                      pre: ({ children }) => (
                        <pre
                          style={{
                            margin: "0 0 8px",
                            padding: 8,
                            borderRadius: 8,
                            background: "rgba(0,0,0,0.08)",
                            overflowX: "auto",
                          }}
                        >
                          {children}
                        </pre>
                      ),
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          );
        })}

        {isAsking && messages[messages.length - 1]?.role !== "assistant" && (
          <div style={{ alignSelf: "flex-start", maxWidth: "90%" }}>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>Claude</div>
            <div
              style={{
                padding: "9px 11px",
                borderRadius: 12,
                background: "rgba(0,0,0,0.06)",
                color: "#222",
                fontSize: 13,
              }}
            >
              Thinking...
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAsk();
            }
          }}
          placeholder="Ask anything about this passage..."
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.15)",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => void handleAsk()}
          disabled={isAsking}
          style={{
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.1)",
            background: "#1f6feb",
            color: "#fff",
            padding: "10px 12px",
          }}
        >
          {isAsking ? "..." : "Send"}
        </button>
      </div>

      {error && (
        <div style={{ color: "#7a1515", fontSize: 12, whiteSpace: "pre-wrap" }}>{error}</div>
      )}
      {lastUsage && (
        <div style={{ fontSize: 11, color: "#666" }}>
          tokens in/out: {lastUsage.inputTokens ?? 0}/{lastUsage.outputTokens ?? 0} | cache create/read:{" "}
          {lastUsage.cacheCreationInputTokens ?? 0}/{lastUsage.cacheReadInputTokens ?? 0}
        </div>
      )}
      {!lastUsage?.cacheCreationInputTokens &&
        !lastUsage?.cacheReadInputTokens &&
        approxContextTokens > 0 &&
        approxContextTokens < 4096 && (
          <div style={{ fontSize: 11, color: "#8a6d3b" }}>
            Context may be too short for Haiku 4.5 prompt caching (approx {approxContextTokens} tokens,
            target 4096+).
          </div>
        )}

      <button
        type="button"
        onClick={handleSave}
        disabled={!canSave}
        style={{
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.12)",
          background: canSave ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.03)",
          padding: "9px 10px",
          cursor: canSave ? "pointer" : "not-allowed",
        }}
      >
        Save as note
      </button>
    </div>
  );
}
