from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _mean(xs: list[float]) -> float | None:
    return statistics.mean(xs) if xs else None


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _judge_rubric_dimension_ids() -> list[str]:
    try:
        p = _repo_root() / "eval" / "config" / "judge_rubric.json"
        data = json.loads(p.read_text(encoding="utf-8"))
        return [str(d["id"]) for d in data.get("dimensions", []) if d.get("id")]
    except (OSError, json.JSONDecodeError, TypeError, KeyError):
        return [
            "faithfulness",
            "chunk_relevance",
            "answer_completeness",
            "claim_precision",
        ]


def _judge_binary_flag_ids() -> list[str]:
    try:
        p = _repo_root() / "eval" / "config" / "judge_rubric.json"
        data = json.loads(p.read_text(encoding="utf-8"))
        return [str(x["id"]) for x in data.get("binaryFlags") or [] if isinstance(x, dict) and x.get("id")]
    except (OSError, json.JSONDecodeError, TypeError, KeyError):
        return []


def _judge_score_numeric(row: dict[str, Any], dim: str) -> float | None:
    js = row.get("judgeScores")
    if not isinstance(js, dict):
        return None
    v = js.get(dim)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip().isdigit():
        return float(int(v.strip()))
    return None


def _mean_judge_scores_by_dimension(rows: list[dict[str, Any]], dim_ids: list[str]) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for dim in dim_ids:
        vals = [_judge_score_numeric(r, dim) for r in rows]
        xs = [v for v in vals if v is not None]
        out[dim] = _mean(xs) if xs else None
    return out


def _mean_judge_flag_rate(rows: list[dict[str, Any]], fid: str) -> float | None:
    vals: list[float] = []
    for r in rows:
        jf = r.get("judgeFlags")
        if isinstance(jf, dict) and fid in jf:
            vals.append(float(jf[fid]))
    return _mean(vals) if vals else None


def _mean_judge_flag_rates_by_id(rows: list[dict[str, Any]], flag_ids: list[str]) -> dict[str, float | None]:
    return {fid: _mean_judge_flag_rate(rows, fid) for fid in flag_ids}


def _judge_flag_row_count(rs: list[dict[str, Any]], flag_ids: list[str]) -> int:
    """Rows with a non-empty judgeFlags map (at least one rubric flag id present)."""
    if not flag_ids:
        return 0
    n = 0
    for r in rs:
        jf = r.get("judgeFlags")
        if not isinstance(jf, dict):
            continue
        if any(fid in jf for fid in flag_ids):
            n += 1
    return n


def _auto_judge_path(score_path: Path) -> Path | None:
    name = score_path.name
    if name.endswith(".score.json"):
        candidate = score_path.with_name(name.replace(".score.json", ".judge.json"))
        return candidate if candidate.is_file() else None
    stem = score_path.stem
    candidate = score_path.with_name(f"{stem}.judge.json")
    return candidate if candidate.is_file() else None


def _judge_index(judge_report: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for j in judge_report.get("judgments", []) or []:
        sk = j.get("stableKey")
        cond = j.get("condition")
        if isinstance(sk, str) and isinstance(cond, str):
            out[(sk, cond)] = j
    return out


def _non_dup_flags(flags: list[str]) -> list[str]:
    return [f for f in flags if f != "deduped_duplicate_run"]


def merge_score_and_judge(
    score_report: dict[str, Any],
    judge_report: dict[str, Any] | None,
    score_path: Path,
    judge_path: Path | None,
) -> list[dict[str, Any]]:
    book_id = score_report.get("bookId") or ""
    j_idx = _judge_index(judge_report) if judge_report else {}

    merged: list[dict[str, Any]] = []
    for row in score_report.get("rows", []) or []:
        sk = row.get("stable_key")
        cond = row.get("condition")
        key = (sk, cond) if isinstance(sk, str) and isinstance(cond, str) else None
        j = j_idx.get(key) if key else None

        j_scores = None
        j_overall = None
        j_violations = None
        j_flags: dict[str, Any] | None = None
        likely_hallucination = False
        if j:
            j_overall = j.get("weightedOverall")
            parsed = j.get("judgment")
            if isinstance(parsed, dict) and not parsed.get("parse_error"):
                j_scores = parsed.get("scores")
                j_violations = parsed.get("violations")
                raw_flags = parsed.get("flags")
                if isinstance(raw_flags, dict):
                    j_flags = {}
                    for k, v in raw_flags.items():
                        j_flags[str(k)] = 1 if v in (1, True) or (isinstance(v, str) and v.strip() == "1") else 0
                faith = None
                if isinstance(j_scores, dict):
                    fv = j_scores.get("faithfulness")
                    if isinstance(fv, (int, float)):
                        faith = int(round(float(fv)))
                if faith is not None and faith <= 2:
                    likely_hallucination = True
                if isinstance(j_violations, list) and len(j_violations) > 0:
                    likely_hallucination = True
                if isinstance(j_flags, dict) and j_flags.get("unsupported_claims") == 1:
                    likely_hallucination = True

        merged.append(
            {
                "bookId": book_id,
                "setName": score_report.get("setName"),
                "stableKey": sk,
                "questionOrdinal": row.get("question_ordinal"),
                "condition": cond,
                "category": row.get("category"),
                "prompt": row.get("prompt"),
                "scoreSource": str(score_path),
                "judgeSource": str(judge_path) if judge_path else None,
                "toolCallCount": row.get("tool_call_count"),
                "retrievedChunkCount": row.get("retrieved_chunk_count"),
                "evidenceRecall": row.get("evidence_recall"),
                "chunkPrecision": row.get("chunk_precision"),
                "evidenceItemsTotal": row.get("evidence_items_total"),
                "evidenceItemsSatisfied": row.get("evidence_items_satisfied"),
                "goldStatus": row.get("gold_status"),
                "answerInAnchor": row.get("answer_in_anchor"),
                "expectedAnswerPointHits": row.get("expected_answer_point_hits"),
                "expectedAnswerPointTotal": row.get("expected_answer_point_total"),
                "flags": row.get("flags") or [],
                "flagsNonDedupe": _non_dup_flags(row.get("flags") or []),
                "judgeWeightedOverall": j_overall,
                "judgeScores": j_scores,
                "judgeFlags": j_flags,
                "judgeViolations": j_violations,
                "likelyHallucination": likely_hallucination,
            }
        )
    return merged


def per_book_summary(book_id: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    rubric_dims = _judge_rubric_dimension_ids()
    flag_ids = _judge_binary_flag_ids()
    by_cond: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_cond[str(r.get("condition") or "")].append(r)
        by_cat[str(r.get("category") or "")].append(r)

    def cond_stats(rs: list[dict[str, Any]]) -> dict[str, Any]:
        recalls = [float(r["evidenceRecall"]) for r in rs if r.get("evidenceRecall") is not None]
        precs = [float(r["chunkPrecision"]) for r in rs if r.get("chunkPrecision") is not None]
        overall = [float(r["judgeWeightedOverall"]) for r in rs if r.get("judgeWeightedOverall") is not None]
        return {
            "rows": len(rs),
            "meanEvidenceRecall": _mean(recalls),
            "meanChunkPrecision": _mean(precs),
            "meanJudgeWeightedOverall": _mean(overall),
            "meanJudgeScoresByDimension": _mean_judge_scores_by_dimension(rs, rubric_dims),
            "judgeFlagRowCount": _judge_flag_row_count(rs, flag_ids),
            "meanJudgeFlagRatesById": _mean_judge_flag_rates_by_id(rs, flag_ids),
        }

    def cat_stats(rs: list[dict[str, Any]]) -> dict[str, Any]:
        return cond_stats(rs)

    flag_counts: dict[str, int] = defaultdict(int)
    for r in rows:
        for f in r.get("flags") or []:
            flag_counts[f] += 1

    problem_keys: set[str] = set()
    for r in rows:
        sk = r.get("stableKey")
        if not isinstance(sk, str):
            continue
        flags = set(r.get("flags") or [])
        if "no_gold_match" in flags or "gold_skeleton" in flags:
            problem_keys.add(sk)
            continue
        cond = r.get("condition")
        if cond in {"tools", "smart_scan_tools"}:
            er = r.get("evidenceRecall")
            tot = r.get("evidenceItemsTotal") or 0
            if er is not None and tot > 0 and float(er) < 1.0:
                problem_keys.add(sk)

    likely_halluc = sum(1 for r in rows if r.get("likelyHallucination"))

    noisy_score = _mean([float(len(_non_dup_flags(r.get("flags") or []))) for r in rows])
    book_judge_dims = _mean_judge_scores_by_dimension(rows, rubric_dims)
    book_flag_rates = _mean_judge_flag_rates_by_id(rows, flag_ids)
    judge_flag_data_rows = _judge_flag_row_count(rows, flag_ids)

    return {
        "bookId": book_id,
        "rowCount": len(rows),
        "judgeBinaryFlagIds": flag_ids,
        "judgeFlagDataRowCount": judge_flag_data_rows,
        "meanJudgeScoresByDimension": book_judge_dims,
        "meanJudgeFlagRatesById": book_flag_rates,
        "meanJudgeWeightedOverall": _mean(
            [float(r["judgeWeightedOverall"]) for r in rows if r.get("judgeWeightedOverall") is not None]
        ),
        "byCondition": {c: cond_stats(rs) for c, rs in sorted(by_cond.items())},
        "byCategory": {c: cat_stats(rs) for c, rs in sorted(by_cat.items())},
        "flagCounts": dict(sorted(flag_counts.items())),
        "problemQuestionCount": len(problem_keys),
        "likelyHallucinationRowCount": likely_halluc,
        "meanNonDedupeFlagsPerRow": noisy_score,
    }


def cross_book_from_merged(all_rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_book: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in all_rows:
        by_book[str(r.get("bookId") or "")].append(r)

    book_summaries = {bid: per_book_summary(bid, rs) for bid, rs in by_book.items() if bid}

    # Hardest category: lowest pooled mean evidence recall
    cat_to_recalls: dict[str, list[float]] = defaultdict(list)
    for r in all_rows:
        cat = str(r.get("category") or "")
        er = r.get("evidenceRecall")
        if er is not None and cat:
            cat_to_recalls[cat].append(float(er))

    cat_means = {c: _mean(vs) for c, vs in cat_to_recalls.items()}
    hardest = None
    if cat_means:
        hardest = min(cat_means.items(), key=lambda x: x[1] if x[1] is not None else 999)

    # Noisiest book: highest meanNonDedupeFlagsPerRow
    noisy = sorted(
        ((bid, s.get("meanNonDedupeFlagsPerRow")) for bid, s in book_summaries.items()),
        key=lambda x: x[1] if x[1] is not None else -1,
        reverse=True,
    )

    books_with_judge = sorted(
        {
            str(r.get("bookId"))
            for r in all_rows
            if r.get("bookId")
            and (r.get("judgeWeightedOverall") is not None or r.get("judgeScores") is not None)
        }
    )

    rubric_dims = _judge_rubric_dimension_ids()
    flag_ids = _judge_binary_flag_ids()
    pooled_judge_dims = _mean_judge_scores_by_dimension(all_rows, rubric_dims)
    pooled_judge_weighted = _mean(
        [float(r["judgeWeightedOverall"]) for r in all_rows if r.get("judgeWeightedOverall") is not None]
    )
    pooled_flag_rates = _mean_judge_flag_rates_by_id(all_rows, flag_ids)

    return {
        "bookIds": sorted(book_summaries.keys()),
        "bookSummaries": book_summaries,
        "pooledMeanEvidenceRecallByCategory": {k: v for k, v in sorted(cat_means.items())},
        "hardestCategoryByPooledEvidenceRecall": {"category": hardest[0], "mean": hardest[1]} if hardest else None,
        "noisiestBooksByMeanFlagsPerRow": [{"bookId": b, "meanNonDedupeFlagsPerRow": m} for b, m in noisy],
        "bookIdsWithJudgeData": books_with_judge,
        "judgeRubricDimensionIds": rubric_dims,
        "judgeBinaryFlagIds": flag_ids,
        "pooledMeanJudgeWeightedOverall": pooled_judge_weighted,
        "pooledMeanJudgeScoresByDimension": pooled_judge_dims,
        "pooledMeanJudgeFlagRatesById": pooled_flag_rates,
    }


def write_per_question_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    dim_ids = _judge_rubric_dimension_ids()
    flag_ids = _judge_binary_flag_ids()
    judge_cols = [f"judgeScore_{d}" for d in dim_ids]
    judge_flag_cols = [f"judge_flag_{f}" for f in flag_ids]
    fieldnames = [
        "bookId",
        "stableKey",
        "questionOrdinal",
        "condition",
        "category",
        "toolCallCount",
        "retrievedChunkCount",
        "evidenceRecall",
        "chunkPrecision",
        "evidenceItemsTotal",
        "goldStatus",
        "flags",
        "judgeWeightedOverall",
        *judge_cols,
        *judge_flag_cols,
        "likelyHallucination",
        "prompt",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            row_out: dict[str, Any] = {
                "bookId": r.get("bookId"),
                "stableKey": r.get("stableKey"),
                "questionOrdinal": r.get("questionOrdinal"),
                "condition": r.get("condition"),
                "category": r.get("category"),
                "toolCallCount": r.get("toolCallCount"),
                "retrievedChunkCount": r.get("retrievedChunkCount"),
                "evidenceRecall": r.get("evidenceRecall"),
                "chunkPrecision": r.get("chunkPrecision"),
                "evidenceItemsTotal": r.get("evidenceItemsTotal"),
                "goldStatus": r.get("goldStatus"),
                "flags": ";".join(r.get("flags") or []),
                "judgeWeightedOverall": r.get("judgeWeightedOverall"),
                "likelyHallucination": r.get("likelyHallucination"),
                "prompt": (r.get("prompt") or "").replace("\n", " ")[:500],
            }
            for d in dim_ids:
                v = _judge_score_numeric(r, d)
                row_out[f"judgeScore_{d}"] = int(v) if v is not None and v == int(v) else v
            jf = r.get("judgeFlags") if isinstance(r.get("judgeFlags"), dict) else {}
            for fid in flag_ids:
                row_out[f"judge_flag_{fid}"] = jf.get(fid, "")
            w.writerow(row_out)


def _fmt_num(x: Any, nd: int = 4) -> str:
    if x is None:
        return "—"
    if isinstance(x, (int, float)):
        return str(round(float(x), nd))
    return str(x)


def write_summary_md(path: Path, payload: dict[str, Any]) -> None:
    lines: list[str] = []
    lines.append("# Eval report summary")
    lines.append("")
    lines.append(f"Generated from **{len(payload.get('scoreFiles', []))}** score file(s).")
    lines.append("")
    cb = payload.get("crossBook") or {}
    rubric_dims: list[str] = list(cb.get("judgeRubricDimensionIds") or _judge_rubric_dimension_ids())
    flag_ids_summary: list[str] = list(cb.get("judgeBinaryFlagIds") or _judge_binary_flag_ids())
    lines.append("## Cross-book")
    lines.append("")
    pooled_j = cb.get("pooledMeanJudgeScoresByDimension") or {}
    pj_w = cb.get("pooledMeanJudgeWeightedOverall")
    if pj_w is not None:
        lines.append(f"- **Pooled mean judge weighted overall:** {_fmt_num(pj_w, nd=3)}")
    if isinstance(pooled_j, dict) and pooled_j and any(v is not None for v in pooled_j.values()):
        if pj_w is not None:
            lines.append("")
        lines.append("**Pooled mean judge rubric scores (1–5, only rows with that criterion scored):**")
        parts = [f"`{d}` {_fmt_num(pooled_j.get(d), nd=3)}" for d in rubric_dims if pooled_j.get(d) is not None]
        lines.append("- " + " · ".join(parts) if parts else "- (no per-criterion judge data)")
        lines.append("")
    pooled_fr = cb.get("pooledMeanJudgeFlagRatesById") or {}
    if flag_ids_summary and isinstance(pooled_fr, dict) and any(pooled_fr.get(f) is not None for f in flag_ids_summary):
        lines.append(
            "**Pooled judge flag rates (mean of 0/1; averaged over merged rows where that flag exists in judge output):**"
        )
        fparts = [f"`{f}` {_fmt_num(pooled_fr.get(f), nd=3)}" for f in flag_ids_summary if pooled_fr.get(f) is not None]
        lines.append("- " + " · ".join(fparts) if fparts else "- (no flag data; re-run judge after rubric `binaryFlags` update)")
        lines.append("")
    h = cb.get("hardestCategoryByPooledEvidenceRecall")
    if h and h.get("category"):
        lines.append(
            f"- **Hardest category (pooled mean evidence recall):** `{h['category']}` → {_fmt_num(h.get('mean'))}"
        )
    else:
        lines.append("- **Hardest category:** insufficient pooled recall data")
    lines.append("- **Noisiest books (mean non-dedupe flags per row):**")
    for item in (cb.get("noisiestBooksByMeanFlagsPerRow") or [])[:6]:
        lines.append(f"  - `{item.get('bookId')}`: {_fmt_num(item.get('meanNonDedupeFlagsPerRow'))}")
    lines.append("")
    lines.append("## Per book")
    lines.append("")
    for bid, s in sorted((cb.get("bookSummaries") or {}).items()):
        lines.append(f"### `{bid}`")
        lines.append("")
        lines.append(f"- Rows: **{s.get('rowCount')}**")
        lines.append(f"- Problem questions (heuristic): **{s.get('problemQuestionCount')}**")
        lines.append(f"- Likely hallucination rows (judge): **{s.get('likelyHallucinationRowCount')}**")
        jm_book = s.get("meanJudgeScoresByDimension") or {}
        mj_w = s.get("meanJudgeWeightedOverall")
        if mj_w is not None or (isinstance(jm_book, dict) and any(v is not None for v in jm_book.values())):
            lines.append("")
            lines.append("**Book-level judge means (all rows with scores):**")
            if mj_w is not None:
                lines.append(f"- Weighted overall: {_fmt_num(mj_w, nd=3)}")
            if isinstance(jm_book, dict):
                parts = [f"`{d}` {_fmt_num(jm_book.get(d), nd=3)}" for d in rubric_dims if jm_book.get(d) is not None]
                if parts:
                    lines.append("- " + " · ".join(parts))
        fr_book = s.get("meanJudgeFlagRatesById") or {}
        if flag_ids_summary and isinstance(fr_book, dict) and any(fr_book.get(f) is not None for f in flag_ids_summary):
            lines.append("")
            lines.append("**Book-level judge flag rates (mean 0–1):**")
            fbparts = [f"`{f}` {_fmt_num(fr_book.get(f), nd=3)}" for f in flag_ids_summary if fr_book.get(f) is not None]
            lines.append("- " + " · ".join(fbparts) if fbparts else "- (no flag data)")
        lines.append("")
        lines.append("| Condition | n | mean recall | mean chunk prec | mean judge overall |")
        lines.append("|-----------|---|------------|-----------------|-------------------|")
        for cond, st in sorted((s.get("byCondition") or {}).items()):
            lines.append(
                f"| {cond} | {st.get('rows')} | {_fmt_num(st.get('meanEvidenceRecall'))} | "
                f"{_fmt_num(st.get('meanChunkPrecision'))} | {_fmt_num(st.get('meanJudgeWeightedOverall'))} |"
            )
        lines.append("")
        dim_header = " | ".join(rubric_dims)
        lines.append("**Mean judge rubric scores by condition (1–5)**")
        lines.append("")
        lines.append(f"| Condition | n | {dim_header} |")
        lines.append("| " + " | ".join(["---"] * (2 + len(rubric_dims))) + " |")
        for cond, st in sorted((s.get("byCondition") or {}).items()):
            jm = st.get("meanJudgeScoresByDimension") or {}
            jcells = " | ".join(_fmt_num(jm.get(d), nd=3) if isinstance(jm, dict) else "—" for d in rubric_dims)
            lines.append(f"| {cond} | {st.get('rows')} | {jcells} |")
        lines.append("")
        lines.append("| Category | n | mean recall | mean chunk prec | mean judge overall |")
        lines.append("|----------|---|------------|-----------------|-------------------|")
        for cat, st in sorted((s.get("byCategory") or {}).items()):
            lines.append(
                f"| {cat} | {st.get('rows')} | {_fmt_num(st.get('meanEvidenceRecall'))} | "
                f"{_fmt_num(st.get('meanChunkPrecision'))} | {_fmt_num(st.get('meanJudgeWeightedOverall'))} |"
            )
        lines.append("")
        lines.append("**Mean judge rubric scores by category (1–5)**")
        lines.append("")
        lines.append(f"| Category | n | {dim_header} |")
        lines.append("| " + " | ".join(["---"] * (2 + len(rubric_dims))) + " |")
        for cat, st in sorted((s.get("byCategory") or {}).items()):
            jm = st.get("meanJudgeScoresByDimension") or {}
            jcells = " | ".join(_fmt_num(jm.get(d), nd=3) if isinstance(jm, dict) else "—" for d in rubric_dims)
            lines.append(f"| {cat} | {st.get('rows')} | {jcells} |")
        lines.append("")
        if flag_ids_summary and (s.get("judgeFlagDataRowCount") or 0) > 0:
            fh = " | ".join(flag_ids_summary)
            lines.append("**Mean judge flag rates by condition (0–1; flag_rows = rows with judge flag data)**")
            lines.append("")
            lines.append(f"| Condition | n | flag_rows | {fh} |")
            lines.append("| " + " | ".join(["---"] * (3 + len(flag_ids_summary))) + " |")
            for cond, st in sorted((s.get("byCondition") or {}).items()):
                fr = st.get("meanJudgeFlagRatesById") or {}
                fcells = " | ".join(
                    _fmt_num(fr.get(fid), nd=3) if isinstance(fr, dict) else "—" for fid in flag_ids_summary
                )
                lines.append(
                    f"| {cond} | {st.get('rows')} | {st.get('judgeFlagRowCount', 0)} | {fcells} |"
                )
            lines.append("")
            lines.append("**Mean judge flag rates by category (0–1)**")
            lines.append("")
            lines.append(f"| Category | n | flag_rows | {fh} |")
            lines.append("| " + " | ".join(["---"] * (3 + len(flag_ids_summary))) + " |")
            for cat, st in sorted((s.get("byCategory") or {}).items()):
                fr = st.get("meanJudgeFlagRatesById") or {}
                fcells = " | ".join(
                    _fmt_num(fr.get(fid), nd=3) if isinstance(fr, dict) else "—" for fid in flag_ids_summary
                )
                lines.append(
                    f"| {cat} | {st.get('rows')} | {st.get('judgeFlagRowCount', 0)} | {fcells} |"
                )
            lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Phase 5 reporting: merge deterministic score JSON + optional judge JSON; emit CSV/JSON/MD."
    )
    parser.add_argument(
        "--score",
        type=Path,
        action="append",
        dest="scores",
        required=True,
        help="Path to *.score.json from score_eval.py (repeat per book/run)",
    )
    parser.add_argument(
        "--judge",
        type=Path,
        action="append",
        dest="judges",
        default=None,
        help="Path to *.judge.json (optional; repeat in same order as --score, or omit to auto-detect)",
    )
    parser.add_argument(
        "--no-auto-judge",
        action="store_true",
        help="Do not look for sibling *.judge.json next to each score file",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        required=True,
        help="Output directory for per_question.*, summaries, SUMMARY.md",
    )
    args = parser.parse_args()

    score_paths = [p.resolve() for p in args.scores]
    judge_paths: list[Path | None]
    if args.judges:
        judge_paths = [p.resolve() for p in args.judges]
        if len(judge_paths) != len(score_paths):
            raise SystemExit("Provide the same number of --judge and --score paths, or omit --judge for auto-detect.")
    else:
        judge_paths = [None] * len(score_paths)

    merged_all: list[dict[str, Any]] = []
    manifest_scores: list[str] = []
    manifest_judges: list[str | None] = []

    for i, sp in enumerate(score_paths):
        print(f"[report] score file {i + 1}/{len(score_paths)}: {sp.name}", file=sys.stderr)
        sr = _load_json(sp)
        jp = judge_paths[i]
        if jp is None and not args.no_auto_judge:
            auto = _auto_judge_path(sp)
            jp = auto
        jr = _load_json(jp) if jp and jp.is_file() else None
        if jr:
            print(f"[report]   merged judge: {jp}", file=sys.stderr)
        else:
            print("[report]   no judge file (deterministic only)", file=sys.stderr)
        manifest_scores.append(str(sp))
        manifest_judges.append(str(jp) if jp and jp.is_file() else None)
        merged_all.extend(merge_score_and_judge(sr, jr, sp, jp if jr else None))

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[report] merged rows: {len(merged_all)} → writing {out_dir}", file=sys.stderr)

    (out_dir / "per_question.json").write_text(
        json.dumps(merged_all, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    write_per_question_csv(out_dir / "per_question.csv", merged_all)

    cb = cross_book_from_merged(merged_all)
    (out_dir / "cross_book_summary.json").write_text(
        json.dumps(cb, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    per_book_only = cb.get("bookSummaries") or {}
    (out_dir / "per_book_summary.json").write_text(
        json.dumps(per_book_only, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    bundle = {
        "scoreFiles": manifest_scores,
        "judgeFiles": manifest_judges,
        "rowCount": len(merged_all),
        "crossBook": cb,
        "perBook": per_book_only,
    }
    (out_dir / "report_bundle.json").write_text(
        json.dumps(bundle, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    write_summary_md(
        out_dir / "SUMMARY.md",
        {"scoreFiles": manifest_scores, "crossBook": cb},
    )

    print(f"[report] done: {out_dir} (per_question.json, per_question.csv, SUMMARY.md, …)", file=sys.stderr)


if __name__ == "__main__":
    main()
