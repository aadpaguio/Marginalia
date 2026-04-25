#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import pandas as pd
import polars as pl
from great_tables import GT, loc, style


REQUIRED_COLUMNS = [
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
    "judgeScore_faithfulness",
    "judgeScore_chunk_relevance",
    "judgeScore_answer_completeness",
    "judgeScore_claim_precision",
    "judge_flag_unsupported_claims",
    "judge_flag_retrieval_problem",
    "judge_flag_incomplete_response",
    "judge_flag_imprecise_or_overbroad",
    "likelyHallucination",
    "prompt",
]

CONDITIONS = ["passage_only", "tools", "smart_scan_tools"]
CATEGORIES = ["cross-section", "book-level-thematic", "nearby-context", "passage-local"]
RUBRICS: List[Tuple[str, str]] = [
    ("faithfulness", "judgeScore_faithfulness"),
    ("chunk relevance", "judgeScore_chunk_relevance"),
    ("completeness", "judgeScore_answer_completeness"),
    ("precision", "judgeScore_claim_precision"),
]
COND_LABELS = {
    "passage_only": "passage only",
    "tools": "tools",
    "smart_scan_tools": "smart scan + tools",
}
COND_SHORT = {"passage_only": "P", "tools": "T", "smart_scan_tools": "SS"}
COND_COLORS = {
    "passage_only": "#B4B2A9",
    "tools": "#85B7EB",
    "smart_scan_tools": "#5DCAA5",
}
EMPTY_FILL = "#F1EFE8"


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def load_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        die(f"Error: CSV not found: {path}")
    df = pd.read_csv(path)
    for col in REQUIRED_COLUMNS:
        if col not in df.columns:
            die(f"Error: missing required column '{col}' in {path}")
    return df


def first_book_id(df: pd.DataFrame, path: Path) -> str:
    if df.empty:
        die(f"Error: CSV has no data rows: {path}")
    raw = str(df.iloc[0]["bookId"]).strip()
    if not raw:
        die(f"Error: first row has empty bookId in {path}")
    return raw


def mean_for(df: pd.DataFrame, condition: str, rubric_col: str, category: Optional[str] = None) -> Optional[float]:
    s = df[df["condition"] == condition]
    if category is not None:
        s = s[s["category"] == category]
    vals = pd.to_numeric(s[rubric_col], errors="coerce").dropna()
    if vals.empty:
        return None
    return float(vals.mean())


def book_condition_rubric_means(df: pd.DataFrame) -> Dict[Tuple[str, str], Optional[float]]:
    out: Dict[Tuple[str, str], Optional[float]] = {}
    for cond in CONDITIONS:
        for _, rcol in RUBRICS:
            out[(cond, rcol)] = mean_for(df, cond, rcol)
    return out


def book_category_condition_rubric_means(df: pd.DataFrame) -> Dict[Tuple[str, str, str], Optional[float]]:
    out: Dict[Tuple[str, str, str], Optional[float]] = {}
    for cat in CATEGORIES:
        for cond in CONDITIONS:
            for _, rcol in RUBRICS:
                out[(cat, cond, rcol)] = mean_for(df, cond, rcol, category=cat)
    return out


def pooled_cell(vals: List[Optional[float]]) -> Optional[float]:
    present = [v for v in vals if v is not None]
    if not present:
        return None
    return float(sum(present) / len(present))


def pooled_condition_rubric(book_stats: List[Dict[Tuple[str, str], Optional[float]]]) -> Dict[Tuple[str, str], Optional[float]]:
    out: Dict[Tuple[str, str], Optional[float]] = {}
    for cond in CONDITIONS:
        for _, rcol in RUBRICS:
            out[(cond, rcol)] = pooled_cell([s[(cond, rcol)] for s in book_stats])
    return out


def pooled_category_condition_rubric(
    book_stats: List[Dict[Tuple[str, str, str], Optional[float]]]
) -> Dict[Tuple[str, str, str], Optional[float]]:
    out: Dict[Tuple[str, str, str], Optional[float]] = {}
    for cat in CATEGORIES:
        for cond in CONDITIONS:
            for _, rcol in RUBRICS:
                out[(cat, cond, rcol)] = pooled_cell([s[(cat, cond, rcol)] for s in book_stats])
    return out


def add_custom_legend(fig: plt.Figure) -> None:
    y = 0.99
    x_start = 0.16
    dx = 0.26
    box = 0.015
    for i, cond in enumerate(CONDITIONS):
        x = x_start + i * dx
        fig.add_artist(
            Rectangle((x, y - box * 0.8), box, box, transform=fig.transFigure, facecolor=COND_COLORS[cond], edgecolor="none")
        )
        fig.text(x + box + 0.008, y - 0.001, COND_LABELS[cond], ha="left", va="center", fontsize=9, color="#22302b")


def plot_condition_chart(
    stats: Dict[Tuple[str, str], Optional[float]],
    out_path: Path,
    title: str,
    pooled_note: Optional[str] = None,
) -> None:
    fig, ax = plt.subplots(figsize=(7, 3.5), dpi=150)

    x = list(range(len(RUBRICS)))
    bar_w = 0.22
    offsets = [-bar_w, 0.0, bar_w]

    for i, cond in enumerate(CONDITIONS):
        xs = [xi + offsets[i] for xi in x]
        ys = [stats[(cond, rcol)] if stats[(cond, rcol)] is not None else float("nan") for _, rcol in RUBRICS]
        ax.bar(xs, ys, width=bar_w * 0.95, color=COND_COLORS[cond], edgecolor="none")

    ax.set_xticks(x)
    ax.set_xticklabels([label for label, _ in RUBRICS], fontsize=9)
    ax.set_ylim(1.0, 5.0)
    y_ticks = [1.0 + 0.5 * i for i in range(9)]
    ax.set_yticks(y_ticks)
    ax.set_yticklabels([f"{t:.1f}" for t in y_ticks], fontsize=8)
    ax.grid(axis="y", color="#e9ece7", linewidth=0.7)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#b9c1bc")
    ax.spines["bottom"].set_color("#b9c1bc")
    ax.set_title(title, fontsize=10.5, pad=12)

    add_custom_legend(fig)
    if pooled_note:
        fig.text(0.01, 0.01, pooled_note, ha="left", va="bottom", fontsize=7.5, color="#4e5953")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, format="svg", bbox_inches="tight")
    plt.close(fig)
    print(out_path)


def heatmap_columns() -> List[str]:
    cols: List[str] = []
    for _rlabel, rcol in RUBRICS:
        for cond in CONDITIONS:
            cols.append(f"{rcol}__{cond}")
    return cols


def stats_to_polars(stats: Dict[Tuple[str, str, str], Optional[float]]) -> pl.DataFrame:
    rows: List[Dict[str, object]] = []
    for cat in CATEGORIES:
        row: Dict[str, object] = {"category": cat}
        for _rlabel, rcol in RUBRICS:
            for cond in CONDITIONS:
                key = f"{rcol}__{cond}"
                row[key] = stats[(cat, cond, rcol)]
        rows.append(row)
    return pl.DataFrame(rows)


def plot_rubric_heatmap(
    stats: Dict[Tuple[str, str, str], Optional[float]],
    out_path: Path,
    title: str,
    pooled_note: Optional[str] = None,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df = stats_to_polars(stats)
    numeric_cols = heatmap_columns()

    gt = (
        GT(df, rowname_col="category")
        .tab_header(
            title=title,
            subtitle="P = passage only  ·  T = tools  ·  SS = smart scan + tools  ·  color scale: 1 → 5",
        )
        .tab_spanner("faithfulness", columns=[f"judgeScore_faithfulness__{c}" for c in CONDITIONS])
        .tab_spanner("chunk relevance", columns=[f"judgeScore_chunk_relevance__{c}" for c in CONDITIONS])
        .tab_spanner("completeness", columns=[f"judgeScore_answer_completeness__{c}" for c in CONDITIONS])
        .tab_spanner("precision", columns=[f"judgeScore_claim_precision__{c}" for c in CONDITIONS])
        .cols_label(
            **{
                f"judgeScore_faithfulness__{c}": COND_SHORT[c] for c in CONDITIONS
            },
            **{
                f"judgeScore_chunk_relevance__{c}": COND_SHORT[c] for c in CONDITIONS
            },
            **{
                f"judgeScore_answer_completeness__{c}": COND_SHORT[c] for c in CONDITIONS
            },
            **{
                f"judgeScore_claim_precision__{c}": COND_SHORT[c] for c in CONDITIONS
            },
        )
        .fmt_number(columns=numeric_cols, decimals=2)
        .data_color(
            columns=numeric_cols,
            palette=["#FFFFFF", "#1D9E75"],
            domain=[1.0, 5.0],
            na_color=EMPTY_FILL,
            autocolor_text=False,
            truncate=True,
        )
        .tab_style(
            style.borders(sides="left", color="#c1cbc6", weight="1px"),
            loc.body(columns=[f"judgeScore_chunk_relevance__{CONDITIONS[0]}", f"judgeScore_answer_completeness__{CONDITIONS[0]}", f"judgeScore_claim_precision__{CONDITIONS[0]}"]),
        )
        .tab_style(
            style.borders(sides="left", color="#c1cbc6", weight="1px"),
            loc.column_labels(columns=[f"judgeScore_chunk_relevance__{CONDITIONS[0]}", f"judgeScore_answer_completeness__{CONDITIONS[0]}", f"judgeScore_claim_precision__{CONDITIONS[0]}"]),
        )
    )
    if pooled_note:
        gt = gt.tab_source_note(pooled_note)

    for col in numeric_cols:
        gt = gt.tab_style(
            style.text(color="#085041"),
            loc.body(columns=[col], rows=pl.col(col) < 3.5),
        )
        gt = gt.tab_style(
            style.text(color="#FFFFFF"),
            loc.body(columns=[col], rows=pl.col(col) >= 3.5),
        )

    gt.save(str(out_path), scale=2.0, expand=5)
    print(out_path)


def build_output_dir(book_id: str) -> Path:
    return Path("presentation") / book_id / "plots"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate per-book and pooled eval plots (SVG chart + PNG heatmap).")
    parser.add_argument("csv", nargs=3, help="Three per_question CSV paths")
    args = parser.parse_args()

    frames: List[pd.DataFrame] = []
    book_ids: List[str] = []
    for p in args.csv:
        path = Path(p)
        df = load_csv(path)
        bid = first_book_id(df, path)
        frames.append(df)
        book_ids.append(bid)

    book_cond_stats: List[Dict[Tuple[str, str], Optional[float]]] = []
    book_cat_cond_stats: List[Dict[Tuple[str, str, str], Optional[float]]] = []

    for df, bid in zip(frames, book_ids):
        cond_stats = book_condition_rubric_means(df)
        cat_cond_stats = book_category_condition_rubric_means(df)
        book_cond_stats.append(cond_stats)
        book_cat_cond_stats.append(cat_cond_stats)

        out_dir = build_output_dir(bid)
        title_base = bid.replace("_", " ")
        plot_condition_chart(cond_stats, out_dir / "condition_scores.svg", title=f"{title_base} — condition rubric means")
        plot_rubric_heatmap(cat_cond_stats, out_dir / "rubric_heatmap.png", title=f"{title_base} — rubric heatmap")

    pooled_cond = pooled_condition_rubric(book_cond_stats)
    pooled_cat_cond = pooled_category_condition_rubric(book_cat_cond_stats)
    pooled_dir = Path("presentation") / "pooled" / "plots"
    pooled_note = "Pooled cells are unweighted means of per-book cell means; cells with no non-NaN book values remain empty."
    plot_condition_chart(
        pooled_cond,
        pooled_dir / "condition_scores.svg",
        title="pooled — condition rubric means",
        pooled_note=pooled_note,
    )
    plot_rubric_heatmap(
        pooled_cat_cond,
        pooled_dir / "rubric_heatmap.png",
        title="pooled — rubric heatmap",
        pooled_note=pooled_note,
    )


if __name__ == "__main__":
    main()
