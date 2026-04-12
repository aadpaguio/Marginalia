import { invoke } from "@tauri-apps/api/core";

export type EvalCondition = "passage_only" | "tools" | "smart_scan_tools";

export interface EvalSetRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
}

export interface EvalQuestionRow {
  id: string;
  setId: string;
  bookId: string;
  sortOrder: number;
  prompt: string;
  category: string | null;
  expectedMinContext: string | null;
  spoilerLabel: string | null;
  anchorCfi: string | null;
  anchorText: string | null;
  chapterLabel: string | null;
}

export interface EvalCreateRunInput {
  id: string;
  questionId: string;
  condition: EvalCondition;
  threadId: string;
}

export interface EvalCompleteRunInput {
  id: string;
  manifestId: string | null;
  status: "completed" | "error" | "pending";
  errorMessage?: string | null;
  answerText?: string | null;
}

export async function evalCreateSet(name: string, description?: string | null): Promise<EvalSetRow> {
  return invoke<EvalSetRow>("eval_create_set", {
    payload: { name, description: description ?? null },
  });
}

export async function evalListSets(): Promise<EvalSetRow[]> {
  return invoke<EvalSetRow[]>("eval_list_sets");
}

export async function evalDeleteSet(id: string): Promise<void> {
  await invoke("eval_delete_set", { id });
}

export async function evalAddQuestionsJson(
  setId: string,
  bookId: string,
  json: string
): Promise<number> {
  return invoke<number>("eval_add_questions_json", {
    payload: { setId, bookId, json },
  });
}

export async function evalListQuestions(setId: string): Promise<EvalQuestionRow[]> {
  return invoke<EvalQuestionRow[]>("eval_list_questions", { payload: { setId } });
}

export async function evalCreateRun(input: EvalCreateRunInput): Promise<void> {
  await invoke("eval_create_run", { input });
}

export async function evalCompleteRun(input: EvalCompleteRunInput): Promise<void> {
  await invoke("eval_complete_run", { input });
}

export async function evalListRunsForQuestion(questionId: string): Promise<unknown[]> {
  return invoke<unknown[]>("eval_list_runs_for_question", { payload: { questionId } });
}

export async function evalExportJsonl(bookId?: string | null): Promise<string> {
  return invoke<string>("eval_export_jsonl", {
    filter: { bookId: bookId ?? null },
  });
}

export async function evalExportCsv(bookId?: string | null): Promise<string> {
  return invoke<string>("eval_export_csv", {
    filter: { bookId: bookId ?? null },
  });
}
