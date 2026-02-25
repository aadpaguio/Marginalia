/**
 * Selection geometry and text utils for the reader (from Readest sel.ts).
 * Used by useInstantAnnotation for text selection and CFI.
 */

export interface Frame {
  top: number;
  left: number;
}

export interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PositionDir = "up" | "down" | "left" | "right";

export interface Position {
  point: Point;
  dir?: PositionDir;
}

export interface TextSelection {
  key: string;
  text: string;
  range: Range;
  index: number;
  cfi?: string;
  href?: string;
  annotated?: boolean;
  rect?: Rect;
}

const frameRect = (frame: Frame, rect?: Rect, sx = 1, sy = 1) => {
  if (!rect) return { left: 0, right: 0, top: 0, bottom: 0 };
  const left = sx * rect.left + frame.left;
  const right = sx * rect.right + frame.left;
  const top = sy * rect.top + frame.top;
  const bottom = sy * rect.bottom + frame.top;
  return { left, right, top, bottom };
};

const pointIsInView = ({ x, y }: Point) =>
  x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight;

const getIframeElement = (nodeElement: Range | Element): HTMLIFrameElement | null => {
  let node: Node | null;
  if (nodeElement && typeof nodeElement === "object" && "tagName" in nodeElement) {
    node = nodeElement as Element;
  } else if (nodeElement && typeof nodeElement === "object" && "collapse" in nodeElement) {
    node = (nodeElement as Range).commonAncestorContainer;
  } else {
    node = nodeElement as Node;
  }
  while (node) {
    if (node.nodeType === Node.DOCUMENT_NODE) {
      const doc = node as Document;
      if (doc.defaultView?.frameElement) {
        return doc.defaultView.frameElement as HTMLIFrameElement;
      }
    }
    node = node.parentNode;
  }
  return null;
};

const constrainPointWithinRect = (point: Point, rect: Rect, padding: number): Point => ({
  x: Math.max(padding, Math.min(point.x, rect.right - rect.left - padding)),
  y: Math.max(padding, Math.min(point.y, rect.bottom - rect.top - padding)),
});

export const isPointerInsideSelection = (selection: Selection, ev: PointerEvent): boolean => {
  if (selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  const padding = 50;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (
      ev.clientX >= rect.left - padding &&
      ev.clientX <= rect.right + padding &&
      ev.clientY >= rect.top - padding &&
      ev.clientY <= rect.bottom + padding
    ) {
      return true;
    }
  }
  return false;
};

export const getPosition = (
  targetElement: Range | Element | TextSelection,
  rect: Rect,
  paddingPx: number,
  isVertical = false
): Position => {
  const { range: target, rect: targetRect } =
    targetElement && "range" in targetElement
      ? (targetElement as TextSelection)
      : { range: targetElement as Range | Element, rect: undefined };
  const frameElement = getIframeElement(target as Range | Element);
  const transform = frameElement ? getComputedStyle(frameElement).transform : "";
  const match = transform.match(/matrix\((.+)\)/);
  const [sx, , , sy] = match?.[1]?.split(/\s*,\s*/)?.map((x) => parseFloat(x)) ?? [];

  const frame: Frame = frameElement?.getBoundingClientRect() ?? { top: 0, left: 0 };
  let padding = { top: 0, right: 0, bottom: 0, left: 0 };
  if ("nodeType" in target && target.nodeType === 1) {
    const computedStyle = window.getComputedStyle(target as Element);
    padding = {
      top: parseInt(computedStyle.paddingTop, 10) || 0,
      right: parseInt(computedStyle.paddingRight, 10) || 0,
      bottom: parseInt(computedStyle.paddingBottom, 10) || 0,
      left: parseInt(computedStyle.paddingLeft, 10) || 0,
    };
  }
  const rects = Array.from((target as Range).getClientRects()).map((r) => ({
    top: r.top + padding.top,
    right: r.right - padding.right,
    bottom: r.bottom - padding.bottom,
    left: r.left + padding.left,
  }));
  const first = targetRect
    ? frameRect(frame, targetRect, sx, sy)
    : frameRect(frame, rects[0], sx, sy);
  const last = targetRect
    ? frameRect(frame, targetRect, sx, sy)
    : frameRect(frame, rects.at(-1), sx, sy);

  if (isVertical) {
    const leftSpace = first.left - rect.left;
    const rightSpace = rect.right - first.right;
    const dir: PositionDir = leftSpace > rightSpace ? "left" : "right";
    const position: Position = {
      point: constrainPointWithinRect(
        {
          x: dir === "left" ? first.left - rect.left - 6 : first.right - rect.left + 6,
          y: (first.top + first.bottom) / 2 - rect.top,
        },
        rect,
        paddingPx
      ),
      dir,
    };
    return pointIsInView(position.point) ? position : ({ point: { x: 0, y: 0 }, dir } as Position);
  }

  const start: Position = {
    point: constrainPointWithinRect(
      { x: (first.left + first.right) / 2 - rect.left, y: first.top - rect.top - 12 },
      rect,
      paddingPx
    ),
    dir: "up",
  };
  const end: Position = {
    point: constrainPointWithinRect(
      { x: (last.left + last.right) / 2 - rect.left, y: last.bottom - rect.top + 6 },
      rect,
      paddingPx
    ),
    dir: "down",
  };
  const startInView = pointIsInView(start.point);
  const endInView = pointIsInView(end.point);
  if (!startInView && !endInView) return { point: { x: 0, y: 0 } };
  if (!startInView) return end;
  if (!endInView) return start;
  return start.point.y > window.innerHeight - end.point.y ? start : end;
};

export const getPopupPosition = (
  position: Position,
  boundingRect: Rect,
  popupWidthPx: number,
  popupHeightPx: number,
  popupPaddingPx: number
): Position => {
  const popupPoint = { x: 0, y: 0 };
  if (position.dir === "up") {
    popupPoint.x = position.point.x - popupWidthPx / 2;
    popupPoint.y = position.point.y - popupHeightPx;
  } else if (position.dir === "down") {
    popupPoint.x = position.point.x - popupWidthPx / 2;
    popupPoint.y = position.point.y + 6;
  } else if (position.dir === "left") {
    popupPoint.x = position.point.x - popupWidthPx;
    popupPoint.y = position.point.y - popupHeightPx / 2;
  } else if (position.dir === "right") {
    popupPoint.x = position.point.x + 6;
    popupPoint.y = position.point.y - popupHeightPx / 2;
  }

  if (popupPoint.x < popupPaddingPx) popupPoint.x = popupPaddingPx;
  if (popupPoint.y < popupPaddingPx) popupPoint.y = popupPaddingPx;
  if (popupPoint.x + popupWidthPx > boundingRect.right - boundingRect.left - popupPaddingPx) {
    popupPoint.x = boundingRect.right - boundingRect.left - popupPaddingPx - popupWidthPx;
  }
  if (popupPoint.y + popupHeightPx > boundingRect.bottom - boundingRect.top - popupPaddingPx) {
    popupPoint.y = boundingRect.bottom - boundingRect.top - popupPaddingPx - popupHeightPx;
  }

  return { point: popupPoint, dir: position.dir };
};

export const snapRangeToWords = (range: Range): void => {
  if (typeof Intl === "undefined" || !Intl.Segmenter) return;

  const isPunctuation = (ch: string) => /^\p{P}|\p{S}$/u.test(ch);

  const snapStartToWordBoundary = () => {
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    const offset = range.startOffset;
    if (offset === 0 || offset >= text.length) return;

    const charAtOffset = text[offset] ?? "";
    if (isPunctuation(charAtOffset)) return;

    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const seg of segmenter.segment(text)) {
      if (seg.isWordLike && seg.index < offset && seg.index + seg.segment.length > offset) {
        range.setStart(node, seg.index);
        break;
      }
    }
  };

  const snapEndToWordBoundary = () => {
    const node = range.endContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    const offset = range.endOffset;
    if (offset === 0 || offset >= text.length) return;

    const charBeforeOffset = text[offset - 1] ?? "";
    if (isPunctuation(charBeforeOffset)) return;

    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const seg of segmenter.segment(text)) {
      if (seg.isWordLike && seg.index < offset && seg.index + seg.segment.length > offset) {
        range.setEnd(node, seg.index + seg.segment.length);
        break;
      }
    }
  };

  snapStartToWordBoundary();
  snapEndToWordBoundary();
};

export const getTextFromRange = (range: Range, rejectTags: string[] = []): string => {
  const clonedRange = range.cloneRange();
  const fragment = clonedRange.cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (rejectTags.includes(parent?.tagName.toLowerCase() ?? "")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let text = "";
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    text += node.nodeValue ?? "";
  }

  return text;
};
