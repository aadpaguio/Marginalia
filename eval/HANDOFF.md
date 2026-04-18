# Marginalia eval pipeline — handoff for next session

This document summarizes the automated evaluation work so a new chat can continue without re-reading the full history.

## Goal

Repeatable **hybrid eval** for Marginalia reading assistant runs:

1. **Deterministic** scoring from CSV tool traces + `eval/gold/*.json`
2. **LLM judge** (default **Haiku**) using only anchor + retrieved tool text + model answer + gold hints
3. **Reporting**: per-question CSV/JSON, per-book and cross-book summaries, `SUMMARY.md`

## Repo locations

| What              | Path                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Book texts        | `books/*.txt` (canonical paths in `eval/config/book_sources.json`; duplicates like `walden_thoreau.txt` / `the_souls_of_black_folk.txt` are documented only) |
| Question sets     | `eval/questions/*.txt` (6 books, 15 questions each)                                                                                                          |
| Gold annotations  | `eval/gold/<bookId>.json` — **Walden filled**; others are **skeleton** `status: skeleton`                                                                    |
| Runset → book map | `eval/config/runset_to_book.json` (e.g. `walden_test_1` → `walden`) — **add new CSV setNames here**                                                          |
| Judge rubric      | `eval/config/judge_rubric.json` — dimensions, weights, **`binaryFlags`** (0/1 failure modes), default model `claude-haiku-4-5-20251001`                        |
| Run exports       | `eval/results/*.csv` (gitignored) — drop app exports here; reports go to `eval/results/reports/`                                                               |
| Scripts           | `eval/scripts/*.py`, `eval/scripts/run_eval_pipeline.sh`                                                                                                     |

## Commands (run from repo root)

**Full pipeline** (score → optional judge → report):

```bash
./eval/scripts/run_eval_pipeline.sh "eval/results/<your>.csv"
./eval/scripts/run_eval_pipeline.sh "eval/results/<your>.csv" --with-judge
```

The script sources **`${REPO}/.env`** and sets `ANTHROPIC_API_KEY` from `VITE_ANTHROPIC_API_KEY` if needed. If you run **`judge_eval.py` alone**, do the same (`set -a; source .env; set +a; export ANTHROPIC_API_KEY=…`) or exports will fail.

**Piecemeal:**

```bash
python3 eval/scripts/validate_questions.py              # question file heuristics
python3 eval/scripts/validate_questions.py --strict
python3 eval/scripts/validate_gold.py
python3 eval/scripts/validate_gold.py --strict --require-ready

python3 eval/scripts/score_eval.py --csv eval/results/<run>.csv --out eval/results/reports/<stem>.score.json

python3 eval/scripts/judge_eval.py --csv eval/results/<run>.csv \
  --out eval/results/reports/<stem>.judge.json

python3 eval/scripts/report_eval.py \
  --score eval/results/reports/<stem>.score.json \
  --out-dir eval/results/reports/<stem>_report
```

**Judge options:**

- `--resume` — continue from partial `*.judge.json` (`incomplete: true`); pipeline auto-adds `--resume` when it detects that.
- `--retry-parse-errors` — **with `--resume` and `--out`**: drop judgments with `judgment.parse_error`, checkpoint, then re-call the API only for those `(stableKey, condition)` pairs (after rubric / parser fixes).
- `--sleep-between-requests 3` (default **3** s) — ease TPM bursts.
- `--quiet` — less stderr progress (429 lines still print).
- `--model …` — override Haiku (e.g. Sonnet for audit).
- `--stable-key` / `--condition` — filter rows (one condition per run if you combine flags; avoid accidental Cartesian products).

**Report:** auto-finds sibling `<stem>.judge.json` next to `<stem>.score.json` unless `--no-auto-judge`.

## Outputs

After pipeline with stem derived from CSV basename (under `eval/results/reports/`):

- `<stem>.score.json`
- `<stem>.judge.json` (if judged)
- `<stem>_report/` — `per_question.json`, `per_question.csv`, `per_book_summary.json`, `cross_book_summary.json`, `SUMMARY.md`, `report_bundle.json`

**Judge JSON:** each `judgments[]` item has `weightedOverall` and `judgment` with **`flags` first** (each rubric `binaryFlags` id → **0 or 1**), then `scores`, `rationales`, `violations`. Parse failures keep `parse_error` / `raw` / optional `repair_raw`.

**Merged report:** `per_question` rows include `judgeScores`, **`judgeFlags`**, `judgeViolations`; CSV adds `judgeScore_*` and **`judge_flag_*`** columns. `SUMMARY.md` includes pooled / per-book **mean rubric scores** and **mean flag rates** (0–1) by condition and category when flag data exists.

## Deterministic scorer behavior (important)

- **Dedupes** CSV rows: key `(prompt, anchorCfi, condition)` — duplicate runs collapse to **one** row (keeps earliest by `runCreatedAt`, then `questionId`). Example: **90 raw rows → 45** when every question×condition was run twice. Dropped siblings are flagged **`deduped_duplicate_run`** on the kept row (`dedupe_group_size` in score JSON).
- **`passage_only`**: does **not** score evidence recall (null); flags `evidence_not_scored_passage_only` when gold still lists evidence.
- **Fairness note:** historical `tools` condition in CSV may only expose `get_context`; `smart_scan_tools` exposes full tool set — compare conditions carefully.

## Judge behavior (important)

- **No full book** in the judge prompt — only **ALLOWED_EVIDENCE** (anchor + tool outputs) + answer + gold hints.
- **Output:** JSON only; **markdown ```json fences** stripped; **`json.JSONDecoder().raw_decode`** used if prose precedes JSON; one **repair** API call on hard parse failure.
- **Binary flags:** model must emit **`flags.<id>` ∈ {0,1}** for every id in `judge_rubric.json` → `binaryFlags` (failure modes on top of numeric scores).
- **429 / TPM:** judge retries with backoff; writes **checkpoints** after each row (`incomplete: true`) so crashes are not total loss.
- **Progress:** stderr lines prefixed `[judge]`, `[score]`, `[report]`.

## Gold schema (v1)

Each entry: `stableKey` (`<bookId>_q01` …), `status`, `answerInAnchor`, `requiredEvidence` (`nearby_text` / `book_section` + `mustContain` / `mustMentionAny`), `expectedAnswerPoints`, `negativeConstraints`.

**Walden:** `walden_q12` is `needs_review` (ice/water/bathing target not pinned to one passage).

**Other books:** skeleton entries need manual `requiredEvidence` / points before deterministic + judge scores are meaningful.

## Known question-design warnings

`validate_questions.py` flags **Walden Q6 / Q9** as leaky `nearby-context` (answer already in anchor). Consider rewriting anchors or recategorizing to `passage-local`.

## Dependencies

Python **3.10+**; **stdlib only** (urllib for Anthropic). No `pip install` required for these scripts (`eval/requirements-eval.txt` states this).

## Suggested next steps for a new session

1. Add **`runset_to_book.json`** entries for new eval CSVs.
2. Fill **`eval/gold/*.json`** for non-Walden books (copy Walden shape).
3. Run pipeline on all six books; use **`report_eval.py`** with multiple `--score` paths for cross-book summary.
4. Re-judge after rubric changes: `--resume --retry-parse-errors` to refresh only `parse_error` rows.

---

*Generated for continuity; extend this file if the workflow changes.*
