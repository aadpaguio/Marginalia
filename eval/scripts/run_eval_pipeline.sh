#!/usr/bin/env bash
# Run deterministic scoring, optional LLM judge, and Phase 5 reporting for one Marginalia eval CSV.
#
# Usage:
#   ./eval/scripts/run_eval_pipeline.sh path/to/results.csv
#   ./eval/scripts/run_eval_pipeline.sh path/to/results.csv --with-judge
#
# Requires: python3 on PATH. Judge step needs an API key when using --with-judge:
#   ANTHROPIC_API_KEY, or VITE_ANTHROPIC_API_KEY (e.g. from repo-root .env).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "${ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi
# Eval scripts use ANTHROPIC_API_KEY; Vite uses VITE_ANTHROPIC_API_KEY — accept either.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${VITE_ANTHROPIC_API_KEY:-}}"

REPORTS_DIR="${ROOT}/eval/results/reports"
CSV="${1:?Usage: $0 <path-to-eval-results.csv> [--with-judge]}"

WITH_JUDGE=false
if [[ "${2:-}" == "--with-judge" ]]; then
  WITH_JUDGE=true
elif [[ -n "${2:-}" ]]; then
  echo "Unknown option: $2 (expected --with-judge or nothing)" >&2
  exit 1
fi

STEM="$(basename "$CSV" .csv)"
SCORE_JSON="${REPORTS_DIR}/${STEM}.score.json"
JUDGE_JSON="${REPORTS_DIR}/${STEM}.judge.json"
REPORT_DIR="${REPORTS_DIR}/${STEM}_report"

mkdir -p "$REPORTS_DIR"

echo "==> Scoring: $CSV"
python3 "${ROOT}/eval/scripts/score_eval.py" --csv "$CSV" --out "$SCORE_JSON"

if $WITH_JUDGE; then
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "ANTHROPIC_API_KEY is not set; cannot run judge." >&2
    exit 1
  fi
  # Avoid "${arr[@]}" on an empty array with set -u (breaks on macOS Bash 3.2).
  echo "==> Judging (Haiku): $CSV"
  if [[ -f "$JUDGE_JSON" ]] && grep -q '"incomplete": true' "$JUDGE_JSON" 2>/dev/null; then
    echo "==> Resuming judge from partial $JUDGE_JSON"
    python3 "${ROOT}/eval/scripts/judge_eval.py" --csv "$CSV" --out "$JUDGE_JSON" --resume
  else
    python3 "${ROOT}/eval/scripts/judge_eval.py" --csv "$CSV" --out "$JUDGE_JSON"
  fi
else
  echo "==> Skipping judge (pass --with-judge to run; needs ANTHROPIC_API_KEY or VITE_ANTHROPIC_API_KEY)"
fi

echo "==> Reporting -> $REPORT_DIR"
python3 "${ROOT}/eval/scripts/report_eval.py" --score "$SCORE_JSON" --out-dir "$REPORT_DIR"

echo "Done."
echo "  Score JSON:  $SCORE_JSON"
if $WITH_JUDGE; then
  echo "  Judge JSON: $JUDGE_JSON"
fi
echo "  Report dir: $REPORT_DIR (see SUMMARY.md)"
