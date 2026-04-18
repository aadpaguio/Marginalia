from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from parse_questions import (  # noqa: E402
    load_book_sources_config,
    parse_questions_file,
)
from score_eval import (  # noqa: E402
    book_id_for_row,
    dedupe_rows,
    extract_retrieval_chunks,
    load_gold_for_book,
    load_runset_map,
    match_question,
    parse_tool_calls,
    score_run_csv,
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_judge_rubric() -> dict[str, Any]:
    p = _repo_root() / "eval" / "config" / "judge_rubric.json"
    return json.loads(p.read_text(encoding="utf-8"))


def format_rubric_for_prompt(rubric: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"# {rubric.get('title', 'Judge rubric')}")
    sc = rubric.get("scale", {})
    lines.append(
        f"Scale: integers {sc.get('min')}-{sc.get('max')} ({sc.get('minLabel')} … {sc.get('maxLabel')})."
    )
    lines.append("")
    for rule in rubric.get("globalRules", []):
        lines.append(f"- {rule}")
    lines.append("")
    for dim in rubric.get("dimensions", []):
        did = dim.get("id")
        lines.append(f"## {did} (weight {dim.get('weight')})")
        lines.append(dim.get("definition", ""))
        anchors = dim.get("anchors") or {}
        for k in sorted(anchors.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
            lines.append(f"  {k}: {anchors[k]}")
        lines.append("")
    return "\n".join(lines).strip()


def binary_flag_ids_from_rubric(rubric: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for x in rubric.get("binaryFlags") or []:
        if isinstance(x, dict) and x.get("id"):
            out.append(str(x["id"]))
    return out


def format_binary_flags_for_prompt(rubric: dict[str, Any]) -> str:
    lines: list[str] = ["Binary failure-mode flags (each must be integer 0 or 1):"]
    for x in rubric.get("binaryFlags") or []:
        if isinstance(x, dict) and x.get("id"):
            lines.append(f"- **{x['id']}** = 1 when: {x.get('whenOne', '').strip()}")
    return "\n".join(lines).strip()


def normalize_judge_flags(raw: Any, flag_ids: list[str]) -> dict[str, int]:
    src = raw if isinstance(raw, dict) else {}
    out: dict[str, int] = {}
    for fid in flag_ids:
        v = src.get(fid)
        one = False
        if v is True:
            one = True
        elif isinstance(v, (int, float)) and int(round(float(v))) == 1:
            one = True
        elif isinstance(v, str) and v.strip() in ("1", "true", "True", "yes", "Y", "y"):
            one = True
        out[fid] = 1 if one else 0
    return out


def assemble_judgment_output(
    parsed: dict[str, Any],
    dim_ids: list[str],
    flag_ids: list[str],
) -> dict[str, Any]:
    """Ordered judgment object: flags first, then scores, rationales, violations."""
    if parsed.get("parse_error"):
        return dict(parsed)
    flags = normalize_judge_flags(parsed.get("flags"), flag_ids)
    scores_raw = parsed.get("scores") if isinstance(parsed, dict) else {}
    scores: dict[str, int] = {}
    if isinstance(scores_raw, dict):
        for did in dim_ids:
            v = scores_raw.get(did)
            if isinstance(v, (int, float)):
                scores[did] = int(round(float(v)))
            elif isinstance(v, str) and v.strip().isdigit():
                scores[did] = int(v.strip())
    rat = parsed.get("rationales")
    viol = parsed.get("violations")
    out: dict[str, Any] = {
        "flags": flags,
        "scores": scores,
        "rationales": rat if isinstance(rat, dict) else {},
        "violations": viol if isinstance(viol, list) else [],
    }
    if parsed.get("_repair_pass"):
        out["_repair_pass"] = True
    return out


def anchor_for_stable_key(book_id: str, stable_key: str, cfg: dict[str, Any]) -> str | None:
    book_cfg = next(b for b in cfg["books"] if b["id"] == book_id)
    qpath = _repo_root() / "eval" / "questions" / f"{book_cfg['questionStem']}.txt"
    for q in parse_questions_file(qpath, cfg):
        if q.stable_key == stable_key:
            return q.anchor_passage
    return None


def build_allowed_evidence(anchor_text: str, tool_calls_raw: str | None) -> str:
    parts: list[str] = []
    parts.append("## Anchor passage (user selection)\n" + (anchor_text or "").strip())
    calls = parse_tool_calls(tool_calls_raw)
    chunks = extract_retrieval_chunks(calls)
    if not chunks:
        parts.append("\n## Retrieved tool excerpts\n(none)")
        return "\n\n".join(parts)
    blocks = ["\n## Retrieved tool excerpts\n"]
    for i, ch in enumerate(chunks, 1):
        blocks.append(f"### Chunk {i} — {ch['tool']}\n{ch['text'].strip()}")
    parts.append("\n".join(blocks))
    return "\n\n".join(parts)


def anthropic_messages(
    *,
    api_key: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int = 2048,
    max_retries_on_429: int = 14,
) -> dict[str, Any]:
    payload = json.dumps(
        {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
    ).encode("utf-8")

    last_body = ""
    for attempt in range(max_retries_on_429):
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "content-type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_body = e.read().decode("utf-8", errors="replace")
            if e.code != 429:
                raise RuntimeError(f"Anthropic API HTTP {e.code}: {last_body}") from e
            if attempt == max_retries_on_429 - 1:
                raise RuntimeError(f"Anthropic API HTTP 429 (exhausted retries): {last_body}") from e
            ra = e.headers.get("Retry-After") if e.headers else None
            if ra and ra.isdigit():
                wait_s = float(ra)
            else:
                wait_s = min(120.0, (2**attempt) * 1.5) + random.uniform(0.0, 1.5)
            print(
                f"[judge] 429 rate limit — sleeping {wait_s:.1f}s then retry "
                f"({attempt + 1}/{max_retries_on_429})",
                file=sys.stderr,
            )
            time.sleep(wait_s)

    raise RuntimeError(f"Anthropic API HTTP 429: {last_body}")


def extract_text_content(message: dict[str, Any]) -> str:
    parts: list[str] = []
    for block in message.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text") or "")
    return "".join(parts).strip()


def strip_markdown_json_fence(text: str) -> str:
    """Haiku often wraps JSON in ```json ... ``` despite instructions; strip for json.loads."""
    t = text.strip()
    if not t.startswith("```"):
        return t
    first_nl = t.find("\n")
    if first_nl == -1:
        return t
    body = t[first_nl + 1 :]
    closing = body.rfind("```")
    if closing != -1:
        body = body[:closing]
    return body.strip()


def parse_model_json(text: str) -> dict[str, Any] | None:
    """Parse assistant JSON: fenced blocks, whole string, or first JSON object embedded in prose."""
    t = strip_markdown_json_fence(text.strip())
    try:
        out = json.loads(t)
        return out if isinstance(out, dict) else None
    except json.JSONDecodeError:
        pass
    dec = json.JSONDecoder()
    i = t.find("{")
    if i == -1:
        return None
    try:
        obj, _end = dec.raw_decode(t, i)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def judgment_has_parse_error(entry: dict[str, Any]) -> bool:
    inner = entry.get("judgment")
    return isinstance(inner, dict) and bool(inner.get("parse_error"))


def weighted_overall(scores: dict[str, int], rubric: dict[str, Any]) -> float | None:
    dims = {d["id"]: float(d.get("weight") or 0) for d in rubric.get("dimensions", [])}
    num = 0.0
    den = 0.0
    for did, w in dims.items():
        if did in scores and w > 0:
            num += scores[did] * w
            den += w
    return num / den if den > 0 else None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LLM judge for Marginalia eval runs (default: Haiku). Uses eval/config/judge_rubric.json."
    )
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override model id (default: judge_rubric.json defaultModel)",
    )
    parser.add_argument(
        "--stable-key",
        action="append",
        dest="stable_keys",
        default=None,
        help="Only judge rows matching this stableKey (repeatable). Default: all deduped rows.",
    )
    parser.add_argument(
        "--condition",
        action="append",
        dest="conditions",
        default=None,
        help="Only judge rows with this condition (repeatable), e.g. smart_scan_tools",
    )
    parser.add_argument("--max-rows", type=int, default=0, help="Cap rows after filters (0 = no cap)")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write full JSON report (default: stdout)",
    )
    parser.add_argument(
        "--merge-deterministic",
        action="store_true",
        help="Include deterministic score_run_csv() report under key deterministic",
    )
    parser.add_argument(
        "--api-key-env",
        default="ANTHROPIC_API_KEY",
        help="Environment variable holding the Anthropic API key",
    )
    parser.add_argument(
        "--sleep-between-requests",
        type=float,
        default=3.0,
        help="Seconds to wait between API calls (reduces TPM bursts). Use 0 to disable.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="If --out exists with incomplete=true, skip (stableKey, condition) pairs already in judgments.",
    )
    parser.add_argument(
        "--retry-parse-errors",
        action="store_true",
        help="With --resume: remove judgments where judgment.parse_error is true, then re-call the API for those "
        "(stableKey, condition) pairs only. Writes a checkpoint after removal.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Less stderr progress (429 retries and fatal errors still print).",
    )
    args = parser.parse_args()

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key and args.api_key_env == "ANTHROPIC_API_KEY":
        api_key = os.environ.get("VITE_ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print(
            "Missing Anthropic API key. Set ANTHROPIC_API_KEY, or VITE_ANTHROPIC_API_KEY "
            f"(current --api-key-env is {args.api_key_env!r}).",
            file=sys.stderr,
        )
        raise SystemExit(1)

    def log(msg: str) -> None:
        if not args.quiet:
            print(msg, file=sys.stderr)

    rubric = load_judge_rubric()
    model = args.model or rubric.get("defaultModel") or "claude-haiku-4-5-20251001"
    rubric_text = format_rubric_for_prompt(rubric)
    dim_ids = [d["id"] for d in rubric.get("dimensions", [])]
    flag_ids = binary_flag_ids_from_rubric(rubric)
    flags_prompt = format_binary_flags_for_prompt(rubric)

    cfg = load_book_sources_config()
    csv_path = args.csv.resolve()

    csv.field_size_limit(sys.maxsize)
    with csv_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print("Empty CSV", file=sys.stderr)
        raise SystemExit(2)

    set_name = rows[0].get("setName") or ""
    runset_map = load_runset_map()
    book_id = book_id_for_row(set_name, runset_map)
    log(
        f"[judge] CSV: {csv_path.name} ({len(rows)} raw rows) → bookId={book_id!r} setName={set_name!r}"
    )
    gold = load_gold_for_book(book_id)
    gold_by_key = {e["stableKey"]: e for e in gold.get("entries", []) if "stableKey" in e}

    deduped, _ = dedupe_rows(rows)

    filters_sk = set(args.stable_keys) if args.stable_keys else None
    filters_cond = set(args.conditions) if args.conditions else None

    selected: list[dict[str, str]] = []
    for r in deduped:
        m = match_question(book_id, r.get("prompt", ""), r.get("category", ""), cfg)
        if not m:
            continue
        sk, _ord = m
        if filters_sk is not None and sk not in filters_sk:
            continue
        if filters_cond is not None and r.get("condition") not in filters_cond:
            continue
        selected.append(r)
        if args.max_rows and len(selected) >= args.max_rows:
            break

    log(
        f"[judge] model={model!r} sleep_between_requests={args.sleep_between_requests}s "
        f"out={args.out or '(stdout)'} resume={args.resume}"
    )
    log(f"[judge] selected {len(selected)} deduped row(s) after filters (stable-key / condition caps).")

    system_prompt = "\n\n".join(
        [
            "You are an expert literary reading evaluator scoring assistant answers for an ebook reading app.",
            "You must follow the rubric exactly and output ONLY valid JSON (no markdown fences).",
            "Never reply with prose-only analysis. If ALLOWED_EVIDENCE is insufficient, still output the JSON object with "
            "appropriately low scores (especially answer_completeness and/or chunk_relevance), explain why in rationales, "
            "and add a short note to violations. Do not refuse to emit JSON.",
            rubric_text,
            "",
            flags_prompt if flags_prompt else "(no binary flags configured in rubric)",
            "",
            "Output JSON schema:",
            json.dumps(
                {
                    "flags": {fid: "<int: only 0 or 1>" for fid in flag_ids} if flag_ids else {},
                    "scores": {did: "<int 1-5>" for did in dim_ids},
                    "rationales": {did: "<one or two sentences>" for did in dim_ids},
                    "violations": ["<optional unsupported claims or issues>"],
                },
                indent=2,
            ),
        ]
    )

    report_base: dict[str, Any] = {
        "csv": str(csv_path),
        "bookId": book_id,
        "setName": set_name,
        "rubricPath": str(_repo_root() / "eval" / "config" / "judge_rubric.json"),
        "model": model,
    }

    judgments: list[dict[str, Any]] = []
    done_keys: set[tuple[str, str]] = set()
    if (
        args.resume
        and args.out
        and args.out.is_file()
    ):
        try:
            prev = json.loads(args.out.read_text(encoding="utf-8"))
            if prev.get("bookId") == book_id and prev.get("setName") == set_name:
                judgments = list(prev.get("judgments") or [])
                done_keys = {
                    (str(j.get("stableKey")), str(j.get("condition")))
                    for j in judgments
                    if j.get("stableKey") and j.get("condition") is not None
                }
                log(f"[judge] resume: loaded {len(judgments)} judgments from {args.out}")
        except (json.JSONDecodeError, OSError) as e:
            print(f"[judge] resume: could not read {args.out}: {e}", file=sys.stderr)

    def flush_out(incomplete: bool) -> None:
        if not args.out:
            return
        obj = dict(report_base)
        obj["judgments"] = judgments
        obj["rowsJudged"] = len(judgments)
        obj["incomplete"] = incomplete
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        log(f"[judge] checkpoint → {args.out.name} ({len(judgments)} judgments, incomplete={incomplete})")

    if args.retry_parse_errors:
        if not args.resume:
            print("[judge] --retry-parse-errors requires --resume", file=sys.stderr)
            raise SystemExit(2)
        if not args.out:
            print("[judge] --retry-parse-errors requires --out", file=sys.stderr)
            raise SystemExit(2)
        before_ct = len(judgments)
        judgments = [j for j in judgments if not judgment_has_parse_error(j)]
        dropped = before_ct - len(judgments)
        done_keys = {
            (str(j.get("stableKey")), str(j.get("condition")))
            for j in judgments
            if j.get("stableKey") and j.get("condition") is not None
        }
        if dropped:
            log(
                f"[judge] retry-parse-errors: removed {dropped} judgment(s) with parse_error; "
                f"will re-judge those (stableKey, condition) pairs."
            )
            flush_out(incomplete=True)

    worklist: list[tuple[dict[str, str], str, str, int]] = []
    for r in selected:
        m = match_question(book_id, r.get("prompt", ""), r.get("category", ""), cfg)
        assert m
        sk, q_ord = m
        cond = str(r.get("condition") or "")
        if (sk, cond) in done_keys:
            continue
        worklist.append((r, sk, cond, q_ord))

    skipped = len(selected) - len(worklist)
    if skipped:
        log(f"[judge] skipping {skipped} row(s) already present (resume / duplicate keys).")
    log(f"[judge] API calls to make: {len(worklist)}")
    if not worklist:
        log("[judge] nothing left to judge; writing final report from existing judgments.")

    first_api_call = True
    for call_i, (r, stable_key, cond, q_ord) in enumerate(worklist, start=1):
        if not first_api_call and args.sleep_between_requests > 0:
            log(f"[judge] sleeping {args.sleep_between_requests}s before next request…")
            time.sleep(args.sleep_between_requests)
        g_ent = gold_by_key.get(stable_key, {})
        anchor = anchor_for_stable_key(book_id, stable_key, cfg) or ""
        allowed = build_allowed_evidence(anchor, r.get("manifestToolCallsMade"))

        gold_payload = {
            "expectedAnswerPoints": g_ent.get("expectedAnswerPoints") or [],
            "negativeConstraints": g_ent.get("negativeConstraints") or [],
            "answerInAnchor": g_ent.get("answerInAnchor"),
            "goldStatus": g_ent.get("status"),
        }

        user_block = "\n\n".join(
            [
                f"condition: {r.get('condition')}",
                f"category: {r.get('category')}",
                f"stableKey: {stable_key}",
                f"question (prompt):\n{r.get('prompt', '')}",
                "",
                "gold rubric hints (for completeness; still obey ALLOWED_EVIDENCE rules):\n"
                + json.dumps(gold_payload, ensure_ascii=False, indent=2),
                "",
                "ALLOWED_EVIDENCE:\n" + allowed,
                "",
                "ASSISTANT_ANSWER:\n" + (r.get("assistantMessageContent") or "").strip(),
                "",
                "MANDATORY: Your entire reply must be one JSON object matching the schema (optionally wrapped in a "
                "single ```json code block). Do not add paragraphs before or after the JSON.",
            ]
        )

        log(f"[judge] requesting {call_i}/{len(worklist)} {stable_key} {cond} …")
        raw = anthropic_messages(
            api_key=api_key,
            model=model,
            system=system_prompt,
            user=user_block,
        )
        text = extract_text_content(raw)
        parsed = parse_model_json(text)
        if parsed is None:
            log(f"[judge] parse failed → one repair pass ({stable_key} {cond})")
            flag_clause = (
                "Include flags object: each of "
                + ", ".join(flag_ids)
                + " must be integer 0 or 1. "
                if flag_ids
                else ""
            )
            repair_system = (
                "You fix judge outputs. The previous model reply was not valid JSON. "
                "Return ONLY one JSON object with keys flags (each 0 or 1), scores, rationales, violations. "
                + flag_clause
                + "If the prose says evidence is missing, assign low scores and set flags accordingly. "
                "No markdown fences, no commentary outside JSON."
            )
            repair_user = (
                "Convert the following model reply into valid JSON only.\n\n---\n"
                + text[:14000]
                + "\n---\n\nReturn JSON only."
            )
            raw_repair = anthropic_messages(
                api_key=api_key,
                model=model,
                system=repair_system,
                user=repair_user,
                max_tokens=4096,
            )
            text_repair = extract_text_content(raw_repair)
            parsed = parse_model_json(text_repair)
            if parsed is None:
                parsed = {
                    "parse_error": True,
                    "raw": text,
                    "repair_raw": text_repair,
                }
            else:
                parsed["_repair_pass"] = True

        judgment_out = assemble_judgment_output(parsed, dim_ids, flag_ids)
        parse_err = bool(judgment_out.get("parse_error"))
        scores = judgment_out.get("scores") if isinstance(judgment_out.get("scores"), dict) else {}
        overall = weighted_overall(scores, rubric) if scores and not parse_err else None

        u_usage = raw.get("usage") or {}
        in_tok = u_usage.get("input_tokens")
        out_tok = u_usage.get("output_tokens")
        tok_hint = ""
        if in_tok is not None or out_tok is not None:
            tok_hint = f" tokens in={in_tok} out={out_tok}"
        log(
            f"[judge] done {call_i}/{len(worklist)} {stable_key} {cond} "
            f"weightedOverall={overall}{tok_hint}"
            + (" JSON_PARSE_ERROR" if parse_err else "")
        )

        judgments.append(
            {
                "stableKey": stable_key,
                "questionOrdinal": q_ord,
                "condition": r.get("condition"),
                "category": r.get("category"),
                "model": model,
                "usage": raw.get("usage"),
                "weightedOverall": overall,
                "judgment": judgment_out,
            }
        )
        done_keys.add((stable_key, cond))
        flush_out(incomplete=True)
        first_api_call = False

    report: dict[str, Any] = dict(report_base)
    report["rowsJudged"] = len(judgments)
    report["judgments"] = judgments
    report["incomplete"] = False
    if args.merge_deterministic:
        log("[judge] merge-deterministic: running score_run_csv on CSV (this can take a bit)…")
        report["deterministic"] = score_run_csv(csv_path, cfg)
        log("[judge] merge-deterministic: done.")

    out_text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(out_text, encoding="utf-8")
        log(f"[judge] finished → {args.out} ({len(judgments)} judgments, complete)")
    else:
        sys.stdout.write(out_text)
        log(f"[judge] finished → stdout ({len(judgments)} judgments)")


if __name__ == "__main__":
    main()
