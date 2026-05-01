import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  CLAUDE_CHAT_MODEL_PRESETS,
  DEFAULT_CHAT_MODEL_ID,
} from "@/services/claude";
import { appSettingsSet } from "@/services/appSettings";

type Props = {
  open: boolean;
  /** Cancel, backdrop, or X — not used after a successful save. */
  onRequestClose: () => void;
  /** Called after settings are persisted and reloaded (closes modal without onboarding-dismiss side effects). */
  onCloseAfterSave: () => void;
  hasApiKey: boolean;
  preferredModel: string | null;
  onSaved: () => Promise<void>;
};

export function SettingsModal({
  open,
  onRequestClose,
  onCloseAfterSave,
  hasApiKey,
  preferredModel,
  onSaved,
}: Props) {
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [modelId, setModelId] = useState<string>(DEFAULT_CHAT_MODEL_ID);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setApiKeyInput("");
    setModelId(preferredModel?.trim() || DEFAULT_CHAT_MODEL_ID);
    setError(null);
  }, [open, preferredModel]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof appSettingsSet>[0] = {
        preferredModel: modelId.trim() || DEFAULT_CHAT_MODEL_ID,
      };
      const trimmed = apiKeyInput.trim();
      if (trimmed) {
        patch.apiKey = trimmed;
      }
      await appSettingsSet(patch);
      await onSaved();
      onCloseAfterSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!window.confirm("Remove the saved Anthropic API key from this device?")) return;
    setSaving(true);
    setError(null);
    try {
      await appSettingsSet({ clearApiKey: true });
      setApiKeyInput("");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onRequestClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          borderRadius: 12,
          background: "#fff",
          color: "#222",
          boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>Settings</strong>
          <button
            type="button"
            onClick={onRequestClose}
            aria-label="Close settings"
            style={{ border: "none", background: "transparent", cursor: "pointer", padding: 4, color: "#666" }}
          >
            <X size={20} />
          </button>
        </div>
        <p style={{ fontSize: 13, color: "#555", lineHeight: 1.45, marginBottom: 16 }}>
          Marginalia uses your Anthropic API key only on this computer. The key is stored in the app&apos;s local
          database folder (submission build). Use an API key from{" "}
          <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>
          .
        </p>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Anthropic API key</label>
        <p style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          {hasApiKey ? "A key is saved. Paste a new key to replace it, or clear it below." : "No key saved yet."}
        </p>
        <input
          type="password"
          autoComplete="off"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder={hasApiKey ? "Paste new key to replace…" : "sk-ant-…"}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #ccc",
            fontSize: 14,
            marginBottom: 16,
          }}
        />
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Chat model</label>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #ccc",
            fontSize: 14,
            marginBottom: 16,
          }}
        >
          {CLAUDE_CHAT_MODEL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {error && (
          <div style={{ fontSize: 13, color: "#b00020", marginBottom: 12 }} role="alert">
            {error}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-end" }}>
          {hasApiKey && (
            <button
              type="button"
              onClick={() => void handleClearKey()}
              disabled={saving}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #ccc",
                background: "#f5f5f5",
                cursor: saving ? "default" : "pointer",
                fontSize: 13,
              }}
            >
              Remove key
            </button>
          )}
          <button
            type="button"
            onClick={onRequestClose}
            disabled={saving}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #ccc",
              background: "#fff",
              cursor: saving ? "default" : "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: "#1f6feb",
              color: "#fff",
              cursor: saving ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
