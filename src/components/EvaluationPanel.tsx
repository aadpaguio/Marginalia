import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { EvalCondition, EvalQuestionRow, EvalSetRow } from "@/services/eval";
import {
  evalAddQuestionsJson,
  evalCreateSet,
  evalDeleteSet,
  evalExportCsv,
  evalExportJsonl,
  evalListQuestions,
  evalListRunsForQuestion,
  evalListSets,
} from "@/services/eval";

type EvaluationPanelProps = {
  bookId: string;
  bookTitle: string;
  scanStatus: "none" | "in_progress" | "done";
  /** Run one eval condition; creates thread + run rows + persists messages (implemented in App). */
  onRunCondition: (question: EvalQuestionRow, condition: EvalCondition) => Promise<void>;
};

const CONDITIONS: { id: EvalCondition; label: string; hint: string }[] = [
  { id: "passage_only", label: "Passage-only", hint: "No tools, no scan context in prompt" },
  { id: "tools", label: "Tools (get_context)", hint: "Local retrieval only" },
  {
    id: "smart_scan_tools",
    label: "Smart Scan + tools",
    hint: "Requires Smart Scan done for this book",
  },
];

export function EvaluationPanel({ bookId, bookTitle, scanStatus, onRunCondition }: EvaluationPanelProps) {
  const [sets, setSets] = useState<EvalSetRow[]>([]);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<EvalQuestionRow[]>([]);
  const [newSetName, setNewSetName] = useState("");
  const [importJson, setImportJson] = useState("");
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [selectedCondition, setSelectedCondition] = useState<EvalCondition>("passage_only");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [runsPreview, setRunsPreview] = useState<unknown[]>([]);

  const refreshSets = useCallback(async () => {
    const list = await evalListSets();
    setSets(list);
    setActiveSetId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refreshSets();
  }, [refreshSets]);

  useEffect(() => {
    if (!activeSetId) {
      setQuestions([]);
      return;
    }
    void evalListQuestions(activeSetId).then(setQuestions);
  }, [activeSetId]);

  const selectedQuestion = questions.find((q) => q.id === selectedQuestionId) ?? null;

  useEffect(() => {
    if (!selectedQuestionId) {
      setRunsPreview([]);
      return;
    }
    void evalListRunsForQuestion(selectedQuestionId).then(setRunsPreview);
  }, [selectedQuestionId, busy]);

  const handleCreateSet = async () => {
    const name = newSetName.trim() || `Set ${new Date().toLocaleDateString()}`;
    setBusy(true);
    setMessage(null);
    try {
      const row = await evalCreateSet(name, null);
      setNewSetName("");
      await refreshSets();
      setActiveSetId(row.id);
      setMessage(`Created set "${row.name}"`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleImportQuestions = async () => {
    if (!activeSetId) {
      setMessage("Select or create a set first.");
      return;
    }
    const raw = importJson.trim();
    if (!raw) {
      setMessage("Paste a JSON array of questions (see EVALUATION_PLAN.md).");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const n = await evalAddQuestionsJson(activeSetId, bookId, raw);
      setImportJson("");
      setMessage(`Imported ${n} question(s).`);
      setQuestions(await evalListQuestions(activeSetId));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSet = async () => {
    if (!activeSetId) return;
    if (!window.confirm("Delete this eval set and all its questions/runs?")) return;
    setBusy(true);
    try {
      await evalDeleteSet(activeSetId);
      setActiveSetId(null);
      await refreshSets();
      setMessage("Set deleted.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async () => {
    if (!selectedQuestion) {
      setMessage("Select a question.");
      return;
    }
    if (selectedCondition === "smart_scan_tools" && scanStatus !== "done") {
      setMessage("Smart Scan must be completed for this book before running smart_scan_tools.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onRunCondition(selectedQuestion, selectedCondition);
      setMessage("Run completed. Check export or thread DB for this eval thread.");
      if (selectedQuestionId) {
        setRunsPreview(await evalListRunsForQuestion(selectedQuestionId));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRunAllConditions = async () => {
    if (!selectedQuestion) {
      setMessage("Select a question.");
      return;
    }
    if (scanStatus !== "done") {
      setMessage("For “Run all 3”, Smart Scan should be done (smart_scan_tools will fail otherwise).");
    }
    setBusy(true);
    setMessage(null);
    try {
      for (const c of CONDITIONS) {
        if (c.id === "smart_scan_tools" && scanStatus !== "done") continue;
        await onRunCondition(selectedQuestion, c.id);
      }
      setMessage("Finished running available conditions.");
      if (selectedQuestionId) {
        setRunsPreview(await evalListRunsForQuestion(selectedQuestionId));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (format: "jsonl" | "csv") => {
    setBusy(true);
    setMessage(null);
    try {
      const text =
        format === "jsonl" ? await evalExportJsonl(bookId) : await evalExportCsv(bookId);
      const path = await save({
        defaultPath: `marginalia-eval-${bookTitle.replace(/[^\w\-]+/g, "_").slice(0, 40)}.${format === "jsonl" ? "jsonl" : "csv"}`,
        filters:
          format === "jsonl"
            ? [{ name: "JSON Lines", extensions: ["jsonl"] }]
            : [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) {
        setMessage("Export cancelled.");
        return;
      }
      await invoke("eval_save_export_file", { payload: { path, contents: text } });
      setMessage(`Saved export to ${path}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="evaluation-panel"
      style={{
        marginTop: 12,
        padding: 12,
        border: "1px solid var(--border-subtle, #ddd)",
        borderRadius: 8,
        background: "var(--surface-elevated, #f7f6f4)",
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Evaluation mode</div>
      <div style={{ color: "var(--text-secondary, #555)", marginBottom: 10 }}>
        Book: <strong>{bookTitle}</strong> · Smart Scan: <strong>{scanStatus}</strong>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span>Eval set</span>
          <select
            value={activeSetId ?? ""}
            onChange={(e) => setActiveSetId(e.target.value || null)}
            style={{ minWidth: 200 }}
          >
            <option value="">—</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void handleDeleteSet()}>
          Delete set
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          placeholder="New set name"
          value={newSetName}
          onChange={(e) => setNewSetName(e.target.value)}
          style={{ flex: "1 1 160px", minWidth: 140 }}
        />
        <button type="button" disabled={busy} onClick={() => void handleCreateSet()}>
          New set
        </button>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
        <span>Import questions (JSON array)</span>
        <textarea
          value={importJson}
          onChange={(e) => setImportJson(e.target.value)}
          rows={4}
          placeholder={`Paste a JSON array. Tip: “Copy for eval” copies one object; paste several separated by commas inside [ ].\n\n[\n  { "prompt": "…", "anchorCfi": "…", "anchorText": "…" },\n  { "prompt": "…", "anchorCfi": "…", "anchorText": "…" }\n]`}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
        />
      </label>
      <button type="button" disabled={busy || !activeSetId} onClick={() => void handleImportQuestions()}>
        Import into set
      </button>

      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Question
          <select
            value={selectedQuestionId ?? ""}
            onChange={(e) => setSelectedQuestionId(e.target.value || null)}
            style={{ minWidth: 260 }}
          >
            <option value="">—</option>
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.sortOrder}: {q.prompt.slice(0, 72)}
                {q.prompt.length > 72 ? "…" : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Condition
          <select
            value={selectedCondition}
            onChange={(e) => setSelectedCondition(e.target.value as EvalCondition)}
          >
            {CONDITIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
        {CONDITIONS.find((c) => c.id === selectedCondition)?.hint}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={() => void handleRun()}>
          Run selected
        </button>
        <button type="button" disabled={busy} onClick={() => void handleRunAllConditions()}>
          Run all conditions
        </button>
        <button type="button" disabled={busy} onClick={() => void handleExport("jsonl")}>
          Export JSONL
        </button>
        <button type="button" disabled={busy} onClick={() => void handleExport("csv")}>
          Export CSV
        </button>
      </div>

      {message && (
        <div style={{ marginTop: 10, color: "var(--ink-primary)", whiteSpace: "pre-wrap" }}>{message}</div>
      )}

      {runsPreview.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>Recent runs for selected question ({runsPreview.length})</summary>
          <pre style={{ fontSize: 10, overflow: "auto", maxHeight: 160 }}>
            {JSON.stringify(runsPreview, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
