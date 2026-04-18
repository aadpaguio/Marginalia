from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class ParsedQuestion:
    book_id: str
    source_file: str
    ordinal: int
    category: str
    expected_tools_raw: str
    chapter_section: str
    prompt: str
    anchor_passage: str
    notes: str

    @property
    def expected_tools(self) -> list[str]:
        raw = self.expected_tools_raw.strip().lower()
        if raw in {"", "none"}:
            return []
        return [part.strip() for part in raw.split(",") if part.strip()]

    @property
    def stable_key(self) -> str:
        return f"{self.book_id}_q{self.ordinal:02d}"


_HEADER_RE = re.compile(r"^##\s*Q(\d+)\s*$", re.MULTILINE)
_FIELD_RE = re.compile(r"^(Category|Expected tools|Chapter/Section|Prompt|Anchor passage|Notes):\s*(.*)$")


def _repo_root_from_here() -> Path:
    # eval/scripts/parse_questions.py -> repo root is parents[2]
    return Path(__file__).resolve().parents[2]


def load_book_sources_config() -> dict[str, Any]:
    cfg_path = _repo_root_from_here() / "eval" / "config" / "book_sources.json"
    return json.loads(cfg_path.read_text(encoding="utf-8"))


def book_id_for_question_file(question_path: Path, cfg: dict[str, Any] | None = None) -> str:
    cfg = cfg or load_book_sources_config()
    stem = question_path.stem
    for book in cfg["books"]:
        if book["questionStem"] == stem:
            return book["id"]
    raise KeyError(f"No book mapping for questions file stem '{stem}' ({question_path})")


def canonical_book_text_path(book_id: str, cfg: dict[str, Any] | None = None) -> Path:
    cfg = cfg or load_book_sources_config()
    root = _repo_root_from_here()
    for book in cfg["books"]:
        if book["id"] == book_id:
            return root / book["canonicalTextPath"]
    raise KeyError(f"Unknown book_id '{book_id}'")


def parse_questions_file(question_path: Path, cfg: dict[str, Any] | None = None) -> list[ParsedQuestion]:
    cfg = cfg or load_book_sources_config()
    book_id = book_id_for_question_file(question_path, cfg)
    text = question_path.read_text(encoding="utf-8")

    # Split on '---' separators; keep blocks that contain a Q header.
    blocks = [b.strip() for b in text.split("\n---\n") if b.strip()]
    questions: list[ParsedQuestion] = []

    for block in blocks:
        m = _HEADER_RE.search(block)
        if not m:
            continue
        ordinal = int(m.group(1))
        body = block[m.end() :].lstrip("\n")

        fields: dict[str, str] = {}
        current_key: str | None = None
        buf: list[str] = []

        def flush() -> None:
            nonlocal current_key, buf
            if current_key is None:
                return
            fields[current_key] = "\n".join(buf).rstrip("\n")
            current_key = None
            buf = []

        for line in body.splitlines():
            fm = _FIELD_RE.match(line)
            if fm:
                flush()
                current_key = fm.group(1)
                buf = [fm.group(2)]
                continue
            if current_key is None:
                # Unexpected preamble lines; ignore.
                continue
            buf.append(line)

        flush()

        required = {"Category", "Expected tools", "Chapter/Section", "Prompt", "Anchor passage", "Notes"}
        missing = sorted(required - set(fields.keys()))
        if missing:
            raise ValueError(f"{question_path}: Q{ordinal} missing fields: {missing}")

        questions.append(
            ParsedQuestion(
                book_id=book_id,
                source_file=str(question_path.relative_to(_repo_root_from_here())),
                ordinal=ordinal,
                category=fields["Category"].strip(),
                expected_tools_raw=fields["Expected tools"].strip(),
                chapter_section=fields["Chapter/Section"].strip(),
                prompt=fields["Prompt"].strip(),
                anchor_passage=fields["Anchor passage"].strip(),
                notes=fields["Notes"].strip(),
            )
        )

    questions.sort(key=lambda q: q.ordinal)
    return questions


def validate_questions(questions: Iterable[ParsedQuestion]) -> list[str]:
    issues: list[str] = []
    seen_ordinals: set[int] = set()
    for q in questions:
        if q.ordinal in seen_ordinals:
            issues.append(f"{q.source_file}: duplicate ordinal Q{q.ordinal}")
        seen_ordinals.add(q.ordinal)

        cat = q.category.strip()
        tools = q.expected_tools

        if cat == "passage-local" and tools:
            issues.append(f"{q.source_file}: Q{q.ordinal}: passage-local but expected tools is not 'none' ({tools})")

        if cat in {"nearby-context", "cross-section", "book-level-thematic"} and not tools:
            issues.append(f"{q.source_file}: Q{q.ordinal}: {cat} but expected tools is empty")

        # Heuristic: quoted phrases in the prompt that appear verbatim in the anchor often mean the question is
        # passage-local (or the anchor leaks the answer target).
        quoted = re.findall(r"“([^”]+)”|'([^']+)'|\"([^\"]+)\"", q.prompt)
        flat: list[str] = []
        for a, b, c in quoted:
            phrase = a or b or c
            if phrase:
                flat.append(phrase)
        for phrase in flat:
            if phrase and phrase in q.anchor_passage:
                if cat == "nearby-context":
                    issues.append(
                        f"{q.source_file}: Q{q.ordinal}: nearby-context but prompt quote appears in anchor: {phrase!r}"
                    )

        prompt_l = q.prompt.lower()
        anchor_l = q.anchor_passage.lower()

        # Heuristic: list questions where the anchor already contains a prototypical list opener.
        if cat == "nearby-context" and "list" in prompt_l and " as " in anchor_l and " and the like" in anchor_l:
            issues.append(
                f"{q.source_file}: Q{q.ordinal}: nearby-context asks for a list, but anchor already contains an 'as … and the like' list pattern"
            )

        # Heuristic: transition-phrase questions should not include the transition sentence in the anchor.
        if cat == "nearby-context" and "transition" in prompt_l:
            # If the anchor already contains the book's pivot clause, retrieval isn't being tested.
            if "the summer, in some climates" in anchor_l:
                issues.append(
                    f"{q.source_file}: Q{q.ordinal}: nearby-context asks for a transition phrase, but anchor already includes 'The summer, in some climates'"
                )

    return issues


def questions_to_jsonable(questions: list[ParsedQuestion]) -> list[dict[str, Any]]:
    return [{**asdict(q), "expected_tools": q.expected_tools, "stable_key": q.stable_key} for q in questions]
