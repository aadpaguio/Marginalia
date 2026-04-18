from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from parse_questions import (
    book_id_for_question_file,
    canonical_book_text_path,
    load_book_sources_config,
    parse_questions_file,
    questions_to_jsonable,
    validate_questions,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse and validate eval/questions/*.txt files.")
    parser.add_argument(
        "--questions-dir",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "eval" / "questions",
        help="Directory containing question files",
    )
    parser.add_argument("--json", action="store_true", help="Print parsed questions as JSON")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero if any validation issues are found (default: warn only)",
    )
    args = parser.parse_args()

    cfg = load_book_sources_config()
    all_issues: list[str] = []
    all_questions = []

    for qfile in sorted(args.questions_dir.glob("*.txt")):
        book_id_for_question_file(qfile, cfg)  # fail fast if mapping missing
        qs = parse_questions_file(qfile, cfg)
        all_questions.extend(qs)
        issues = validate_questions(qs)
        all_issues.extend(issues)

        book_path = canonical_book_text_path(book_id_for_question_file(qfile, cfg), cfg)
        if not book_path.exists():
            all_issues.append(f"Missing canonical book text for {qfile.name}: {book_path}")

        print(f"{qfile.name}: {len(qs)} questions")

    print()
    if all_issues:
        print(f"Issues: {len(all_issues)}")
        for line in all_issues:
            print(f"- {line}")
        if args.strict:
            raise SystemExit(2)
        print()
        print("WARN: issues found, but continuing because --strict was not set.")
    else:
        print("OK: no issues found by validate_questions heuristics.")

    if args.json:
        print(json.dumps(questions_to_jsonable(all_questions), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
