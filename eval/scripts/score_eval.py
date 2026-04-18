from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from parse_questions import (  # noqa: E402
    _repo_root_from_here,
    load_book_sources_config,
    parse_questions_file,
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_runset_map() -> dict[str, str]:
    p = _repo_root_from_here() / "eval" / "config" / "runset_to_book.json"
    data = _load_json(p)
    return {str(k): str(v) for k, v in data.get("setNameToBookId", {}).items()}


def load_gold_for_book(book_id: str) -> dict[str, Any]:
    p = _repo_root_from_here() / "eval" / "gold" / f"{book_id}.json"
    return _load_json(p)


def book_id_for_row(set_name: str, runset_map: dict[str, str]) -> str:
    if set_name in runset_map:
        return runset_map[set_name]
    raise KeyError(
        f"Unknown eval setName {set_name!r}. Add it to eval/config/runset_to_book.json"
    )


def match_question(
    book_id: str, prompt: str, category: str, cfg: dict[str, Any]
) -> tuple[str, int] | None:
    book_cfg = next(b for b in cfg["books"] if b["id"] == book_id)
    qpath = _repo_root_from_here() / "eval" / "questions" / f"{book_cfg['questionStem']}.txt"
    qs = parse_questions_file(qpath, cfg)
    for q in qs:
        if q.prompt == prompt and q.category == category:
            return q.stable_key, q.ordinal
    return None


def parse_tool_calls(raw: str | None) -> list[dict[str, Any]]:
    if not raw or raw.strip() in {"", "[]"}:
        return []
    return json.loads(raw)


def tool_output_to_text(tool: str, output: Any) -> str:
    if output is None:
        return ""
    if not isinstance(output, str):
        return ""
    if tool == "get_context":
        try:
            payload = json.loads(output)
        except json.JSONDecodeError:
            return ""
        txt = payload.get("text")
        return txt if isinstance(txt, str) else ""
    if tool in {"get_section_text", "get_section_summary", "request_web_search"}:
        return output
    return ""


def extract_retrieval_chunks(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for c in calls:
        tool = c.get("tool")
        if not isinstance(tool, str):
            continue
        if c.get("error"):
            continue
        text = tool_output_to_text(tool, c.get("output"))
        if not text.strip():
            continue
        chunks.append({"tool": tool, "text": text, "input": c.get("input")})
    return chunks


def normalize_match_text(s: str) -> str:
    return s.lower()


def evidence_item_satisfied(item: dict[str, Any], corpus: str) -> bool:
    kind = item.get("kind")
    corp = normalize_match_text(corpus)

    must_contain = item.get("mustContain") or []
    if isinstance(must_contain, str):
        must_contain = [must_contain]
    for phrase in must_contain:
        if not phrase:
            continue
        if normalize_match_text(str(phrase)) not in corp:
            return False

    must_any = item.get("mustMentionAny") or []
    if isinstance(must_any, str):
        must_any = [must_any]
    if must_any:
        if not any(normalize_match_text(str(p)) in corp for p in must_any if p):
            return False

    hints = item.get("sectionHints") or []
    if isinstance(hints, str):
        hints = [hints]
    # If we already satisfied mustContain / mustMentionAny, section hints are optional context.
    if hints and not must_contain and not must_any:
        if not any(normalize_match_text(str(h)) in corp for h in hints if h):
            return False

    if kind == "regex" and item.get("pattern"):
        try:
            return re.search(str(item["pattern"]), corpus, re.IGNORECASE | re.DOTALL) is not None
        except re.error:
            return False

    return True


def chunk_relevant_to_gold(chunk_text: str, required_evidence: list[dict[str, Any]]) -> bool:
    """Heuristic: chunk is relevant if it contributes to any evidence item's mustContain / mustMentionAny."""
    terms: list[str] = []
    for item in required_evidence:
        for phrase in item.get("mustContain") or []:
            if phrase:
                terms.append(str(phrase))
        for phrase in item.get("mustMentionAny") or []:
            if phrase:
                terms.append(str(phrase))
    if not terms:
        return False
    low = normalize_match_text(chunk_text)
    return any(normalize_match_text(t) in low for t in terms)


def expected_point_hit(point: str, answer: str) -> bool:
    """Weak deterministic check: at least one significant token from the rubric phrase appears in the answer."""
    if not point.strip() or not answer.strip():
        return False
    tokens = re.findall(r"[A-Za-z']{5,}", point.lower())
    tokens = [t for t in tokens if t not in {"which", "their", "there", "where", "would", "could"}]
    if not tokens:
        tokens = re.findall(r"[A-Za-z']{4,}", point.lower())
    if not tokens:
        return normalize_match_text(point[:80]) in normalize_match_text(answer)
    hits = sum(1 for t in tokens if t in normalize_match_text(answer))
    return hits >= max(1, min(2, len(tokens) // 3))


@dataclass
class RowScore:
    stable_key: str | None
    question_ordinal: int | None
    set_name: str
    book_id: str
    condition: str
    category: str
    prompt: str
    dedupe_group_size: int
    tool_call_count: int
    retrieved_chunk_count: int
    evidence_items_total: int
    evidence_items_satisfied: int
    evidence_recall: float | None
    chunk_precision: float | None
    relevant_chunks: int
    gold_status: str | None
    answer_in_anchor: bool | None
    expected_answer_point_hits: int | None
    expected_answer_point_total: int | None
    flags: list[str]


def dedupe_rows(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], dict[tuple[str, str, str], int]]:
    groups: dict[tuple[str, str, str], list[dict[str, str]]] = defaultdict(list)
    for r in rows:
        key = (r.get("prompt", ""), r.get("anchorCfi", ""), r.get("condition", ""))
        groups[key].append(r)

    def sort_key(r: dict[str, str]) -> tuple[int, str]:
        ts = int(r.get("runCreatedAt") or 0)
        return (ts, r.get("questionId", ""))

    out: list[dict[str, str]] = []
    sizes: dict[tuple[str, str, str], int] = {}
    for key, rs in groups.items():
        sizes[key] = len(rs)
        out.append(sorted(rs, key=sort_key)[0])
    out.sort(key=lambda r: (r.get("prompt", ""), r.get("condition", "")))
    return out, sizes


def score_run_csv(csv_path: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    csv.field_size_limit(sys.maxsize)
    runset_map = load_runset_map()

    with csv_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    if not rows:
        return {"error": "empty csv", "csv": str(csv_path)}

    set_name = rows[0].get("setName") or ""
    book_id = book_id_for_row(set_name, runset_map)
    gold_file = load_gold_for_book(book_id)
    gold_by_key = {e["stableKey"]: e for e in gold_file.get("entries", []) if "stableKey" in e}

    deduped, group_sizes = dedupe_rows(rows)

    row_scores: list[RowScore] = []
    for r in deduped:
        prompt = r.get("prompt", "")
        category = r.get("category", "")
        condition = r.get("condition", "")
        key3 = (prompt, r.get("anchorCfi", ""), condition)
        dsize = group_sizes.get(key3, 1)

        flags: list[str] = []
        if dsize > 1:
            flags.append("deduped_duplicate_run")

        matched = match_question(book_id, prompt, category, cfg)
        stable_key: str | None = None
        q_ord: int | None = None
        if matched:
            stable_key, q_ord = matched
        else:
            flags.append("no_gold_match")

        calls = parse_tool_calls(r.get("manifestToolCallsMade"))
        chunks = extract_retrieval_chunks(calls)

        entry = gold_by_key.get(stable_key or "") if stable_key else None
        gold_status = entry.get("status") if entry else None
        answer_in_anchor = entry.get("answerInAnchor") if entry else None

        required = list(entry.get("requiredEvidence") or []) if entry else []

        if entry and entry.get("status") == "skeleton":
            flags.append("gold_skeleton")

        corpus = "\n\n".join(c["text"] for c in chunks)
        ev_total = len(required)
        ev_sat = sum(1 for item in required if evidence_item_satisfied(item, corpus)) if required else 0
        ev_recall: float | None
        prec: float | None
        rel: int

        # passage_only deliberately withholds tools; do not score retrieval/evidence recall there.
        if condition == "passage_only":
            ev_recall = None
            rel = 0
            prec = None
            if ev_total > 0:
                flags.append("evidence_not_scored_passage_only")
        elif ev_total == 0:
            ev_recall = None
            rel = 0
            prec = None
        else:
            ev_recall = ev_sat / ev_total
            if chunks:
                rel = sum(1 for c in chunks if chunk_relevant_to_gold(c["text"], required))
                prec = rel / len(chunks)
            else:
                rel = 0
                prec = None

        if answer_in_anchor is True and len(required) == 0 and chunks and category == "passage-local":
            flags.append("retrieval_despite_passage_local")

        if condition == "passage_only" and calls:
            flags.append("unexpected_tool_calls_passage_only")

        exp_points = list(entry.get("expectedAnswerPoints") or []) if entry else []
        answer = r.get("assistantMessageContent") or ""
        if exp_points:
            hits = sum(1 for p in exp_points if expected_point_hit(str(p), answer))
            phits, ptot = hits, len(exp_points)
        else:
            phits, ptot = None, None

        row_scores.append(
            RowScore(
                stable_key=stable_key,
                question_ordinal=q_ord,
                set_name=set_name,
                book_id=book_id,
                condition=condition,
                category=category,
                prompt=prompt,
                dedupe_group_size=dsize,
                tool_call_count=len(calls),
                retrieved_chunk_count=len(chunks),
                evidence_items_total=ev_total,
                evidence_items_satisfied=ev_sat,
                evidence_recall=ev_recall,
                chunk_precision=prec,
                relevant_chunks=rel,
                gold_status=gold_status,
                answer_in_anchor=answer_in_anchor,
                expected_answer_point_hits=phits,
                expected_answer_point_total=ptot,
                flags=flags,
            )
        )

    def mean(xs: list[float]) -> float | None:
        return sum(xs) / len(xs) if xs else None

    # Aggregates: only average recall where defined
    by_cond: dict[str, dict[str, Any]] = defaultdict(lambda: {"n": 0, "recall": [], "precision": []})
    for rs in row_scores:
        bucket = by_cond[rs.condition]
        bucket["n"] += 1
        if rs.evidence_recall is not None:
            bucket["recall"].append(rs.evidence_recall)
        if rs.chunk_precision is not None:
            bucket["precision"].append(rs.chunk_precision)

    aggregates = {
        cond: {
            "rows": v["n"],
            "mean_evidence_recall": mean(v["recall"]),
            "mean_chunk_precision": mean(v["precision"]),
        }
        for cond, v in by_cond.items()
    }

    by_cat: dict[str, dict[str, Any]] = defaultdict(lambda: {"n": 0, "recall": [], "precision": []})
    for rs in row_scores:
        bucket = by_cat[rs.category]
        bucket["n"] += 1
        if rs.evidence_recall is not None:
            bucket["recall"].append(rs.evidence_recall)
        if rs.chunk_precision is not None:
            bucket["precision"].append(rs.chunk_precision)

    aggregates_cat = {
        cat: {
            "rows": v["n"],
            "mean_evidence_recall": mean(v["recall"]),
            "mean_chunk_precision": mean(v["precision"]),
        }
        for cat, v in by_cat.items()
    }

    flag_counts: dict[str, int] = defaultdict(int)
    for rs in row_scores:
        for fl in rs.flags:
            flag_counts[fl] += 1

    return {
        "csv": str(csv_path),
        "setName": set_name,
        "bookId": book_id,
        "sourceRows": len(rows),
        "dedupedRows": len(deduped),
        "aggregatesByCondition": aggregates,
        "aggregatesByCategory": aggregates_cat,
        "flagCounts": dict(sorted(flag_counts.items())),
        "rows": [asdict(x) for x in row_scores],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic eval scoring from Marginalia CSV + eval/gold/*.json")
    parser.add_argument("--csv", type=Path, required=True, help="Path to eval results CSV")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write JSON report to this path (default: stdout only)",
    )
    args = parser.parse_args()

    cfg = load_book_sources_config()
    csv_path = args.csv.resolve()
    print(f"[score] reading {csv_path}", file=sys.stderr)
    report = score_run_csv(csv_path, cfg)
    print(
        f"[score] bookId={report.get('bookId')!r} raw={report.get('sourceRows')} "
        f"deduped={report.get('dedupedRows')}",
        file=sys.stderr,
    )
    text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"[score] wrote {args.out.resolve()}", file=sys.stderr)
    else:
        sys.stdout.write(text)
        print("[score] wrote JSON to stdout", file=sys.stderr)


if __name__ == "__main__":
    main()
