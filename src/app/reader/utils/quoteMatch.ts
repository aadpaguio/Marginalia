/**
 * Normalization for matching eval anchor passages and assistant citations to EPUB DOM text.
 * Plain-text eval excerpts often use _underscore italics_, `--` dashes, and paragraph breaks that
 * become different when HTML flattens text nodes (no space across </p><p>).
 */

const BLOCK_TAG = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|HEADER|SECTION|ARTICLE|TD|TH|FIGCAPTION)$/i;

function closestBlockEl(el: Element | null): Element | null {
  let cur: Element | null = el;
  while (cur) {
    if (BLOCK_TAG.test(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return el;
}

/** True when a space is likely missing between adjacent DOM text nodes (cross-block glue). */
export function needsSpaceBetweenAdjacentTextNodes(prev: Text, next: Text): boolean {
  const da = prev.data;
  const db = next.data;
  if (!da.length || !db.length) return false;
  if (/\s$/.test(da) || /^\s/.test(db)) return false;
  const p1 = prev.parentElement;
  const p2 = next.parentElement;
  if (!p1 || !p2) return false;
  if (p1 === p2) return false;
  const b1 = closestBlockEl(p1);
  const b2 = closestBlockEl(p2);
  return b1 !== b2;
}

export type AugmentedPlain = {
  text: string;
  /** For each index in `text`, the corresponding source Text node and offset. */
  charToTextPos: { node: Text; offset: number }[];
};

/** Concatenate visible text with single spaces inserted across block boundaries (mimics common innerText behavior). */
export function buildAugmentedPlainText(body: HTMLElement): AugmentedPlain {
  const nodes: Text[] = [];
  (function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      if (t.length) nodes.push(t);
    } else {
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
  })(body);

  let text = "";
  const charToTextPos: { node: Text; offset: number }[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i];
    if (i > 0 && needsSpaceBetweenAdjacentTextNodes(nodes[i - 1], t)) {
      text += " ";
      charToTextPos.push({ node: nodes[i - 1], offset: nodes[i - 1].length });
    }
    const data = t.data;
    for (let j = 0; j < data.length; j++) {
      text += data[j];
      charToTextPos.push({ node: t, offset: j });
    }
  }
  return { text, charToTextPos };
}

function normalizeSearchChar(c: string): string {
  if (c === "\u201c" || c === "\u201d") c = '"';
  else if (c === "\u2018" || c === "\u2019") c = "'";
  else if (c === "\u2014" || c === "\u2013") c = "-";

  // Treat punctuation / separators as whitespace so edition-level comma/dash differences
  // do not break anchor resolution.
  if (!/[A-Za-z0-9']/.test(c)) return " ";
  return c.toLowerCase();
}

/**
 * Normalize an eval anchor or spine text for substring search against augmented EPUB text.
 * Strips Project-Gutenberg-style _italics_, ignores case, loosens punctuation, and collapses whitespace.
 */
export function normalizeEvalAnchorForSearch(s: string): string {
  const raw = s.replace(/_([^_\s][^_]*?)_/g, "$1");
  let out = "";
  let prevSpace = true;
  for (let i = 0; i < raw.length; i++) {
    const n = normalizeSearchChar(raw[i]);
    if (n === " ") {
      if (!prevSpace) out += " ";
      prevSpace = true;
    } else {
      out += n;
      prevSpace = false;
    }
  }
  return out.trim();
}

/**
 * Build a whitespace-collapsed haystack aligned to augmented EPUB text indices (for indexOf + range mapping).
 */
export function buildSearchHaystack(aug: AugmentedPlain): { hay: string; hayToAugCharIdx: number[] } {
  const raw = aug.text;
  const hayChars: string[] = [];
  const hayToAugCharIdx: number[] = [];
  let prevSpace = true;

  for (let i = 0; i < raw.length; i++) {
    const c = normalizeSearchChar(raw[i]);
    if (c === " ") {
      if (prevSpace) continue;
      hayChars.push(" ");
      hayToAugCharIdx.push(i);
      prevSpace = true;
    } else {
      hayChars.push(c);
      hayToAugCharIdx.push(i);
      prevSpace = false;
    }
  }

  while (hayChars.length > 0 && hayChars[hayChars.length - 1] === " ") {
    hayChars.pop();
    hayToAugCharIdx.pop();
  }

  return { hay: hayChars.join(""), hayToAugCharIdx };
}
