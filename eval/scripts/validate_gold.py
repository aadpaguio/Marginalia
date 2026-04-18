from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from parse_questions import load_book_sources_config, parse_questions_file


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _load_gold(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_gold_file(gold_path: Path, cfg: dict, *, require_ready: bool) -> tuple[list[str], list[str]]:
    structural: list[str] = []
    readiness: list[str] = []
    gold = _load_gold(gold_path)

    book_id = gold.get("bookId")
    if not isinstance(book_id, str) or not book_id:
        structural.append(f"{gold_path}: missing/invalid bookId")
        return structural, readiness

    if gold_path.stem != book_id:
        structural.append(f"{gold_path}: filename stem '{gold_path.stem}' != bookId '{book_id}'")

    entries = gold.get("entries")
    if not isinstance(entries, list) or not entries:
        structural.append(f"{gold_path}: entries must be a non-empty array")
        return structural, readiness

    keys: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            structural.append(f"{gold_path}: entry must be an object")
            continue
        sk = entry.get("stableKey")
        if not isinstance(sk, str) or not sk:
            structural.append(f"{gold_path}: entry missing stableKey")
            continue
        keys.append(sk)

    if len(keys) != len(set(keys)):
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        structural.append(f"{gold_path}: duplicate stableKey entries: {dupes[:10]}{'…' if len(dupes) > 10 else ''}")

    # Cross-check against questions file
    try:
        book_cfg = next(b for b in cfg["books"] if b["id"] == book_id)
    except StopIteration:
        structural.append(f"{gold_path}: bookId '{book_id}' not present in eval/config/book_sources.json")
        return structural, readiness

    qpath = _repo_root() / "eval" / "questions" / f"{book_cfg['questionStem']}.txt"
    if not qpath.exists():
        structural.append(f"{gold_path}: expected questions file missing: {qpath}")
        return structural, readiness

    qs = parse_questions_file(qpath, cfg)
    expected_keys = {q.stable_key for q in qs}
    gold_keys = set(keys)

    missing = sorted(expected_keys - gold_keys)
    extra = sorted(gold_keys - expected_keys)
    if missing:
        structural.append(f"{gold_path}: gold missing {len(missing)} keys (showing up to 15): {missing[:15]}")
    if extra:
        structural.append(f"{gold_path}: gold has {len(extra)} unexpected keys (showing up to 15): {extra[:15]}")

    # Readiness checks (optional)
    if require_ready:
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            sk = entry.get("stableKey")
            status = entry.get("status")
            if status != "ready":
                readiness.append(f"{gold_path}: {sk}: status is {status} (expected ready)")

    return structural, readiness


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate eval/gold/*.json against eval/questions/*.txt")
    parser.add_argument(
        "--gold-dir",
        type=Path,
        default=_repo_root() / "eval" / "gold",
        help="Directory containing <bookId>.json gold files",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero if structural gold issues are found (default: warn only)",
    )
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="Emit readiness failures for non-ready entries (skeleton/needs_review). Use with --strict to fail the run.",
    )
    args = parser.parse_args()

    cfg = load_book_sources_config()
    structural_issues: list[str] = []
    readiness_issues: list[str] = []

    gold_files = sorted([p for p in args.gold_dir.glob("*.json") if p.name != "schema.json"])
    if not gold_files:
        print(f"No gold files found in {args.gold_dir}")
        raise SystemExit(0)

    for gold_path in gold_files:
        print(f"Checking {gold_path.name} …")
        s, r = validate_gold_file(gold_path, cfg, require_ready=args.require_ready)
        structural_issues.extend(s)
        readiness_issues.extend(r)

    print()
    if structural_issues:
        print(f"Structural issues: {len(structural_issues)}")
        for line in structural_issues:
            print(f"- {line}")

    if readiness_issues:
        print(f"Readiness issues: {len(readiness_issues)}")
        for line in readiness_issues[:50]:
            print(f"- {line}")
        if len(readiness_issues) > 50:
            print(f"- … {len(readiness_issues) - 50} more")

    if args.strict and structural_issues:
        raise SystemExit(2)

    if args.strict and args.require_ready and readiness_issues:
        raise SystemExit(2)

    if structural_issues or readiness_issues:
        print()
        if structural_issues and not args.strict:
            print("WARN: structural problems found, but continuing because --strict was not set.")
        if readiness_issues and not (args.strict and args.require_ready):
            print("WARN: readiness problems found, but continuing because --strict + --require-ready was not set.")
    else:
        print("OK: gold files align with questions and basic structural checks pass.")


if __name__ == "__main__":
    main()
