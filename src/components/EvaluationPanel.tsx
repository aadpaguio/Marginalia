import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
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
  /** Resolve anchor passage text to EPUB CFI using the active reader. */
  onResolveAnchor: (input: { anchorText: string; chapterLabel?: string | null }) => Promise<string | null>;
};

type DraftQuestion = {
  id: string;
  sortOrder: number;
  prompt: string;
  category: string | null;
  expectedMinContext: string | null;
  chapterLabel: string | null;
  anchorText: string | null;
  anchorCfi: string | null;
  status: "parsed" | "resolved" | "unresolved";
  error: string | null;
};

const CONDITIONS: { id: EvalCondition; label: string; hint: string }[] = [
  {
    id: "passage_only",
    label: "Passage-only",
    hint: "No tools, no scan in prompt; same turn-scoped lead-up prefetch as normal reading",
  },
  { id: "tools", label: "Tools (get_context)", hint: "Local retrieval only" },
  {
    id: "smart_scan_tools",
    label: "Smart Scan + tools",
    hint: "Requires Smart Scan done for this book",
  },
];

export function EvaluationPanel({
  bookId,
  bookTitle,
  scanStatus,
  onRunCondition,
  onResolveAnchor,
}: EvaluationPanelProps) {
  const [sets, setSets] = useState<EvalSetRow[]>([]);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<EvalQuestionRow[]>([]);
  const [newSetName, setNewSetName] = useState("");
  const [importJson, setImportJson] = useState("");
  const [rawQuestionsText, setRawQuestionsText] = useState("");
  const [draftRows, setDraftRows] = useState<DraftQuestion[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [selectedCondition, setSelectedCondition] = useState<EvalCondition>("passage_only");
  const [busy, setBusy] = useState(false);
  /** Set only while resolving anchors so the bar can show fraction complete. */
  const [resolveProgress, setResolveProgress] = useState<{ current: number; total: number } | null>(null);
  /** Set while eval runs are in flight (single or batch). */
  const [evalRunProgress, setEvalRunProgress] = useState<{
    done: number;
    total: number;
    label: string;
  } | null>(null);
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

  const parseRawQuestions = (raw: string): DraftQuestion[] => {
    const blocks = raw
      .split(/\n\s*---\s*\n/g)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    const rows: DraftQuestion[] = [];
    for (const block of blocks) {
      const qMatch = block.match(/^##\s*Q(\d+)/im);
      if (!qMatch) continue;
      const sortOrder = Number.parseInt(qMatch[1], 10);
      const lineValue = (label: string): string | null => {
        const m = block.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
        return m?.[1]?.trim() || null;
      };
      const anchorMatch = block.match(/Anchor passage:\s*([\s\S]*?)(?:\nNotes:|$)/i);
      const anchorText = anchorMatch?.[1]?.trim() || null;
      const prompt = lineValue("Prompt") ?? "";

      rows.push({
        id: `draft-${sortOrder}-${Math.random().toString(36).slice(2, 8)}`,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : rows.length + 1,
        prompt,
        category: lineValue("Category"),
        expectedMinContext: lineValue("Expected tools"),
        chapterLabel: lineValue("Chapter/Section"),
        anchorText,
        anchorCfi: null,
        status: "parsed",
        error: anchorText ? null : "Missing Anchor passage",
      });
    }

    return rows.sort((a, b) => a.sortOrder - b.sortOrder);
  };

  const handleParseRawQuestions = () => {
    const raw = rawQuestionsText.trim();
    if (!raw) {
      setMessage("Paste the raw eval .txt questions first.");
      return;
    }
    const parsed = parseRawQuestions(raw);
    setDraftRows(parsed);
    if (parsed.length === 0) {
      setMessage("No questions parsed. Expected sections like \"## Q1\" with Prompt and Anchor passage.");
      return;
    }
    setMessage(`Parsed ${parsed.length} question(s).`);
  };

  const conditionLabel = (id: EvalCondition) => CONDITIONS.find((c) => c.id === id)?.label ?? id;

  const handleResolveAnchors = async () => {
    if (draftRows.length === 0) {
      setMessage("Parse questions first.");
      return;
    }
    setEvalRunProgress(null);
    setBusy(true);
    setMessage("Resolving anchors...");
    const nextRows = [...draftRows];
    let resolved = 0;
    let unresolved = 0;
    try {
      for (let i = 0; i < nextRows.length; i++) {
        setResolveProgress({ current: i + 1, total: nextRows.length });
        const row = nextRows[i];
        const anchorText = row.anchorText?.trim() ?? "";
        if (!anchorText) {
          nextRows[i] = {
            ...row,
            status: "unresolved",
            anchorCfi: null,
            error: "Missing Anchor passage",
          };
          unresolved += 1;
          continue;
        }
        const cfi = await onResolveAnchor({ anchorText, chapterLabel: row.chapterLabel });
        if (cfi?.trim()) {
          nextRows[i] = {
            ...row,
            status: "resolved",
            anchorCfi: cfi.trim(),
            error: null,
          };
          resolved += 1;
        } else {
          nextRows[i] = {
            ...row,
            status: "unresolved",
            anchorCfi: null,
            error: "No match found in current book",
          };
          unresolved += 1;
        }
        setDraftRows([...nextRows]);
      }
      setMessage(`Resolved ${resolved}; unresolved ${unresolved}.`);
    } catch (e) {
      setDraftRows(nextRows);
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setResolveProgress(null);
      setBusy(false);
    }
  };

  const handleImportResolved = async () => {
    if (!activeSetId) {
      setMessage("Select or create a set first.");
      return;
    }
    const resolvedRows = draftRows.filter(
      (row) => !!row.prompt.trim() && !!row.anchorText?.trim() && !!row.anchorCfi?.trim()
    );
    if (resolvedRows.length === 0) {
      const resolvedCount = draftRows.filter((r) => r.status === "resolved").length;
      setMessage(
        resolvedCount === 0
          ? "No resolved rows to import yet. Each row needs a non-empty prompt, anchor passage, and resolved CFI. If the table looks empty, parse again or turn off Evaluation mode (that unmounts this panel and clears the draft)."
          : "No rows ready to import: check that every resolved row still has prompt and anchor text (not just CFI)."
      );
      return;
    }
    const payload = resolvedRows.map((row) => ({
      prompt: row.prompt.trim(),
      category: row.category ?? null,
      expectedMinContext: row.expectedMinContext ?? null,
      anchorCfi: row.anchorCfi!.trim(),
      anchorText: row.anchorText!.trim(),
      chapterLabel: row.chapterLabel ?? null,
    }));
    setBusy(true);
    setMessage(null);
    try {
      const n = await evalAddQuestionsJson(activeSetId, bookId, JSON.stringify(payload, null, 2));
      setQuestions(await evalListQuestions(activeSetId));
      setMessage(`Imported ${n} resolved question(s).`);
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
    const label = `${conditionLabel(selectedCondition)} · Q${selectedQuestion.sortOrder}`;
    setBusy(true);
    setMessage(null);
    setEvalRunProgress({ done: 0, total: 1, label });
    try {
      await onRunCondition(selectedQuestion, selectedCondition);
      setEvalRunProgress({ done: 1, total: 1, label });
      setMessage("Run completed. Check export or thread DB for this eval thread.");
      if (selectedQuestionId) {
        setRunsPreview(await evalListRunsForQuestion(selectedQuestionId));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setEvalRunProgress(null);
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
    const runnable = CONDITIONS.filter(
      (c) => c.id !== "smart_scan_tools" || scanStatus === "done"
    );
    const batchLabel = `All conditions · Q${selectedQuestion.sortOrder}`;
    setBusy(true);
    setMessage(null);
    setEvalRunProgress({ done: 0, total: runnable.length, label: batchLabel });
    try {
      let done = 0;
      for (const c of runnable) {
        await onRunCondition(selectedQuestion, c.id);
        done += 1;
        setEvalRunProgress({ done, total: runnable.length, label: batchLabel });
        setMessage(`Running all conditions: ${done}/${runnable.length} completed.`);
      }
      setMessage("Finished running available conditions.");
      if (selectedQuestionId) {
        setRunsPreview(await evalListRunsForQuestion(selectedQuestionId));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setEvalRunProgress(null);
      setBusy(false);
    }
  };

  const handleRunAllQuestionsSelectedCondition = async () => {
    if (questions.length === 0) {
      setMessage("No questions in this set.");
      return;
    }
    if (selectedCondition === "smart_scan_tools" && scanStatus !== "done") {
      setMessage("Smart Scan must be completed for this book before running smart_scan_tools.");
      return;
    }
    const batchLabel = `${conditionLabel(selectedCondition)} · all ${questions.length} question(s)`;
    setBusy(true);
    setMessage(null);
    setEvalRunProgress({ done: 0, total: questions.length, label: batchLabel });
    try {
      let completed = 0;
      for (const q of questions) {
        await onRunCondition(q, selectedCondition);
        completed += 1;
        setEvalRunProgress({ done: completed, total: questions.length, label: batchLabel });
        setMessage(
          `Running ${selectedCondition} for all questions: ${completed}/${questions.length} completed.`
        );
      }
      setMessage(
        `Finished ${selectedCondition} for all ${questions.length} question(s).`
      );
      if (selectedQuestionId) {
        setRunsPreview(await evalListRunsForQuestion(selectedQuestionId));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setEvalRunProgress(null);
      setBusy(false);
    }
  };

  const handleRunAllQuestionsAllConditions = async () => {
    if (questions.length === 0) {
      setMessage("No questions in this set.");
      return;
    }
    const runnableConditions = CONDITIONS.filter(
      (c) => c.id !== "smart_scan_tools" || scanStatus === "done"
    );
    if (runnableConditions.length === 0) {
      setMessage("No runnable conditions available.");
      return;
    }
    const total = questions.length * runnableConditions.length;
    const batchLabel = `All questions × ${runnableConditions.length} condition(s)`;
    setBusy(true);
    setMessage(null);
    setEvalRunProgress({ done: 0, total, label: batchLabel });
    try {
      let completed = 0;
      for (const q of questions) {
        for (const c of runnableConditions) {
          await onRunCondition(q, c.id);
          completed += 1;
          setEvalRunProgress({ done: completed, total, label: batchLabel });
          setMessage(`Running all questions × conditions: ${completed}/${total} completed.`);
        }
      }
      const skipped =
        scanStatus === "done" ? "" : " (smart_scan_tools skipped; Smart Scan not done)";
      setMessage(
        `Finished ${completed} run(s) across ${questions.length} question(s).${skipped}`
      );
      if (selectedQuestionId) {
        setRunsPreview(await evalListRunsForQuestion(selectedQuestionId));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setEvalRunProgress(null);
      setBusy(false);
    }
  };

  const handleExport = async (format: "jsonl" | "csv") => {
    setBusy(true);
    setMessage(null);
    try {
      const text =
        format === "jsonl" ? await evalExportJsonl(bookId) : await evalExportCsv(bookId);
      const sanitizeForFilename = (value: string) =>
        value.replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
      const activeSetName = sets.find((s) => s.id === activeSetId)?.name ?? "set";
      const now = new Date();
      const timestamp = [
        now.getFullYear().toString(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      const path = await save({
        defaultPath: `marginalia-eval-${sanitizeForFilename(activeSetName).slice(0, 40)}-${sanitizeForFilename(bookTitle).slice(0, 40)}-${timestamp}.${format === "jsonl" ? "jsonl" : "csv"}`,
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
        maxHeight: "70vh",
        overflowY: "auto",
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
        <span>Raw questions (.txt)</span>
        <textarea
          value={rawQuestionsText}
          onChange={(e) => setRawQuestionsText(e.target.value)}
          rows={8}
          placeholder={`Paste the eval question text file here.\n\nExpected format:\n## Q1\nCategory: ...\nExpected tools: ...\nChapter/Section: ...\nPrompt: ...\nAnchor passage: ...`}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
        />
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <button type="button" disabled={busy} onClick={handleParseRawQuestions}>
          Parse
        </button>
        <button type="button" disabled={busy || draftRows.length === 0} onClick={() => void handleResolveAnchors()}>
          Resolve anchors
        </button>
        <button
          type="button"
          disabled={busy || draftRows.length === 0 || !activeSetId}
          title={
            busy
              ? "Please wait…"
              : draftRows.length === 0
                ? "Parse questions first, then resolve anchors."
                : !activeSetId
                  ? "Choose or create an eval set above."
                  : "Import resolved rows into the selected set."
          }
          onClick={() => void handleImportResolved()}
        >
          Import resolved
        </button>
      </div>

      {busy && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginBottom: 10,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--border-subtle, #ddd)",
            background: "var(--surface-elevated, #f7f6f4)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <Loader2
              size={16}
              aria-hidden
              style={{
                flexShrink: 0,
                marginTop: 1,
                color: "var(--text-secondary, #555)",
                animation: "spin 0.9s linear infinite",
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--ink-primary)", lineHeight: 1.35 }}>
                {resolveProgress
                  ? `Resolving anchors · ${resolveProgress.current} / ${resolveProgress.total}`
                  : evalRunProgress
                    ? `${evalRunProgress.label} · ${evalRunProgress.done} / ${evalRunProgress.total} finished`
                    : "Working…"}
              </div>
              {evalRunProgress && evalRunProgress.done < evalRunProgress.total && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary, #555)",
                    marginTop: 4,
                  }}
                >
                  Now running {evalRunProgress.done + 1} of {evalRunProgress.total}…
                </div>
              )}
              {resolveProgress && (
                <div
                  role="progressbar"
                  aria-valuenow={resolveProgress.current}
                  aria-valuemin={1}
                  aria-valuemax={resolveProgress.total}
                  style={{
                    marginTop: 6,
                    height: 4,
                    borderRadius: 2,
                    background: "var(--border-subtle, #ddd)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${(resolveProgress.current / resolveProgress.total) * 100}%`,
                      borderRadius: 2,
                      background: "var(--accent, #3d6bb0)",
                      transition: "width 0.15s ease-out",
                    }}
                  />
                </div>
              )}
              {evalRunProgress && !resolveProgress && evalRunProgress.total > 0 && (
                <div
                  role="progressbar"
                  aria-valuenow={evalRunProgress.done}
                  aria-valuemin={0}
                  aria-valuemax={evalRunProgress.total}
                  style={{
                    marginTop: 6,
                    height: 4,
                    borderRadius: 2,
                    background: "var(--border-subtle, #ddd)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${(evalRunProgress.done / evalRunProgress.total) * 100}%`,
                      borderRadius: 2,
                      background: "var(--accent, #3d6bb0)",
                      transition: "width 0.15s ease-out",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {draftRows.length > 0 && (
        <div style={{ marginBottom: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--border-subtle, #ddd)" }}>Q</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--border-subtle, #ddd)" }}>Status</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--border-subtle, #ddd)" }}>Prompt</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--border-subtle, #ddd)" }}>Chapter</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--border-subtle, #ddd)" }}>anchorCfi</th>
              </tr>
            </thead>
            <tbody>
              {draftRows.map((row) => (
                <tr key={row.id}>
                  <td style={{ verticalAlign: "top", padding: "4px 6px" }}>{row.sortOrder}</td>
                  <td style={{ verticalAlign: "top", padding: "4px 6px" }}>
                    {row.status}
                    {row.error ? ` (${row.error})` : ""}
                  </td>
                  <td style={{ verticalAlign: "top", padding: "4px 6px" }}>
                    {row.prompt.slice(0, 80)}
                    {row.prompt.length > 80 ? "…" : ""}
                  </td>
                  <td style={{ verticalAlign: "top", padding: "4px 6px" }}>{row.chapterLabel ?? "—"}</td>
                  <td style={{ verticalAlign: "top", padding: "4px 6px", fontFamily: "monospace" }}>
                    {row.anchorCfi ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
        <button
          type="button"
          disabled={busy || questions.length === 0}
          onClick={() => void handleRunAllQuestionsSelectedCondition()}
        >
          Run all questions (selected condition)
        </button>
        <button
          type="button"
          disabled={busy || questions.length === 0}
          onClick={() => void handleRunAllQuestionsAllConditions()}
        >
          Run all questions (all conditions)
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
