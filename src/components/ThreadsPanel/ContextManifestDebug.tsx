import { useState } from "react";
import { useLatestManifest } from "@/hooks/useLatestManifest";
import type { ContextManifest } from "@/types/contextManifest";

interface ContextManifestDebugProps {
  threadId: string | null;
  refreshTrigger?: number;
  /** When set and threadId matches, show this immediately (avoids waiting for DB). */
  latestCompletedManifest?: ContextManifest | null;
}

export function ContextManifestDebug({
  threadId,
  refreshTrigger,
  latestCompletedManifest,
}: ContextManifestDebugProps) {
  const fromDb = useLatestManifest(threadId, refreshTrigger);
  const manifest: ContextManifest | null =
    latestCompletedManifest?.threadId === threadId
      ? latestCompletedManifest
      : fromDb;

  const [collapsed, setCollapsed] = useState(false);

  if (!import.meta.env.DEV || !threadId) return null;

  return (
    <div
      className="context-manifest-debug"
      style={{
        marginTop: 8,
        padding: "8px 10px",
        fontSize: 11,
        fontFamily: "var(--font-mono, monospace)",
        color: "var(--ink-tertiary, #666)",
        borderTop: "1px solid var(--border-subtle, #e0e0e0)",
        background: "var(--surface-base, #faf9f7)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "4px 0",
          border: "none",
          background: "none",
          cursor: "pointer",
          fontWeight: 600,
          color: "inherit",
        }}
      >
        {collapsed ? "▶ Context used" : "▼ Context used"}
      </button>
      {!collapsed && (
        <div style={{ marginTop: 6 }}>
          {manifest ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span>Turn mode</span>
                  <span style={{ color: "var(--ink-primary)" }}>{manifest.turnMode}</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Active anchor</span>
                  <span style={{ color: "var(--ink-primary)" }}>
                    {manifest.activeAnchorSource}
                    {manifest.activeAnchorChapter ? ` · ${manifest.activeAnchorChapter}` : ""}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>System prompt</span>
                  <span>{manifest.systemPromptChars.toLocaleString()} chars</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Reader profile</span>
                  <span>{manifest.readerProfileIncluded ? `✓ ${manifest.readerProfileChars ?? 0} chars` : "—"}</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Book memory</span>
                  <span>{manifest.bookMemoryIncluded ? `✓ ${manifest.bookMemoryChars ?? 0} chars` : "—"}</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Book overview</span>
                  <span>{manifest.bookOverviewIncluded ? "✓" : "—"}</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Highlights</span>
                  <span>{manifest.highlightsCount}</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>History</span>
                  <span>{manifest.historyMessageCount} messages</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Memory items</span>
                  <span>{manifest.memoryItemsCount}</span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Est. input</span>
                  <span>~{manifest.estimatedInputTokens?.toLocaleString() ?? "—"} tokens</span>
                </div>
              </div>
              <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 6, marginTop: 6 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Tools available</span>
                  <span>{manifest.toolsAvailable?.join(" · ") ?? "—"}</span>
                </div>
                {manifest.smartScanStatus != null && (
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                    <span>Smart Scan</span>
                    <span>{manifest.smartScanStatus}</span>
                  </div>
                )}
              </div>
              <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 6, marginTop: 6 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                  <span>Tool calls</span>
                  <span>
                    {manifest.toolCallsMade?.length
                      ? manifest.toolCallsMade
                          .map((c) => `${c.tool} (round ${c.round})`)
                          .join(", ")
                      : "—"}
                  </span>
                </div>
                {manifest.finalAnswerChars != null && (
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 2 }}>
                    <span>Answer</span>
                    <span>{manifest.finalAnswerChars} chars</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ fontStyle: "italic" }}>No manifest yet for this thread.</div>
          )}
        </div>
      )}
    </div>
  );
}
