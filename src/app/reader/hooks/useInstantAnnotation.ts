/**
 * Text selection in the reader; fires onSelection with { selectedText, cfi } on pointer up.
 * No store deps — props only. No visible highlight in this phase.
 */
import { useCallback, useRef } from "react";
import type { FoliateView } from "@/types/view";
import { Point, getTextFromRange, snapRangeToWords } from "@/utils/sel";

export interface SelectionResult {
  selectedText: string;
  cfi: string;
  anchorX: number;
  anchorY: number;
}

export interface UseInstantAnnotationProps {
  bookKey: string;
  viewRef: React.RefObject<FoliateView | null>;
  onSelection: (selection: SelectionResult) => void;
}

const MIN_DRAG_DISTANCE = 10;

export function useInstantAnnotation({
  bookKey: _bookKey,
  viewRef,
  onSelection,
}: UseInstantAnnotationProps) {
  const startPointRef = useRef<Point | null>(null);
  const startDocRef = useRef<Document | null>(null);
  const startIndexRef = useRef<number>(0);
  /** True when the current pointerdown started a selection gesture (selectable content). Cleared on pointerup/pointercancel so closeSelectionUi can skip dismissing. */
  const selectionGestureStartedRef = useRef(false);

  const findPositionAtPoint = useCallback((doc: Document, x: number, y: number) => {
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  }, []);

  const isSelectableContent = useCallback(
    (doc: Document, x: number, y: number): boolean => {
      const pos = findPositionAtPoint(doc, x, y);
      if (!pos) return false;

      if (pos.node.nodeType !== Node.TEXT_NODE) return false;

      const textNode = pos.node as Text;
      const textLength = textNode.length;
      if (textLength === 0) return false;

      const range = doc.createRange();
      try {
        const startOffset = Math.min(pos.offset, textLength - 1);
        const endOffset = Math.min(pos.offset + 1, textLength);
        range.setStart(textNode, startOffset);
        range.setEnd(textNode, endOffset);

        const rects = range.getClientRects();
        const tolerance = 20;
        for (const rect of rects) {
          if (
            x >= rect.left - tolerance &&
            x <= rect.right + tolerance &&
            y >= rect.top - tolerance &&
            y <= rect.bottom + tolerance
          ) {
            return true;
          }
        }
      } catch {
        return false;
      }
      return false;
    },
    [findPositionAtPoint]
  );

  const createRangeFromPoints = useCallback(
    (doc: Document, startPoint: Point, endPoint: Point): Range | null => {
      const startPos = findPositionAtPoint(doc, startPoint.x, startPoint.y);
      const endPos = findPositionAtPoint(doc, endPoint.x, endPoint.y);

      if (!startPos || !endPos) return null;

      const newRange = doc.createRange();
      try {
        const positionComparison = startPos.node.compareDocumentPosition(endPos.node);
        const needsSwap =
          (positionComparison & Node.DOCUMENT_POSITION_PRECEDING) !== 0 ||
          (startPos.node === endPos.node && startPos.offset > endPos.offset);

        if (needsSwap) {
          newRange.setStart(endPos.node, endPos.offset);
          newRange.setEnd(startPos.node, startPos.offset);
        } else {
          newRange.setStart(startPos.node, startPos.offset);
          newRange.setEnd(endPos.node, endPos.offset);
        }

        if (newRange.collapsed) return null;

        snapRangeToWords(newRange);
        return newRange;
      } catch (e) {
        console.warn("Failed to create range:", e);
        return null;
      }
    },
    [findPositionAtPoint]
  );

  const handleInstantAnnotationPointerDown = useCallback(
    (doc: Document, index: number, ev: PointerEvent): boolean => {
      selectionGestureStartedRef.current = false;
      if (ev.button !== 0) return false;
      if (!isSelectableContent(doc, ev.clientX, ev.clientY)) return false;

      selectionGestureStartedRef.current = true;
      startPointRef.current = { x: ev.clientX, y: ev.clientY };
      startDocRef.current = doc;
      startIndexRef.current = index;
      return true;
    },
    [isSelectableContent]
  );

  const handleInstantAnnotationPointerMove = useCallback(
    (_doc: Document, _index: number, _ev: PointerEvent): boolean => {
      // Phase 5: no preview highlight; just allow drag to extend selection for pointer up
      return !!startPointRef.current && !!startDocRef.current;
    },
    []
  );

  const handleInstantAnnotationPointerCancel = useCallback((): boolean => {
    selectionGestureStartedRef.current = false;
    startPointRef.current = null;
    startDocRef.current = null;
    return true;
  }, []);

  const handleInstantAnnotationPointerUp = useCallback(
    (doc: Document, index: number, ev: PointerEvent): boolean => {
      selectionGestureStartedRef.current = false;
      const view = viewRef.current;

      // Path 1: we had a drag (pointerdown + move + pointerup) — create range from points
      if (startPointRef.current && view) {
        const endPoint: Point = { x: ev.clientX, y: ev.clientY };
        const startPoint = startPointRef.current;
        startPointRef.current = null;
        startDocRef.current = null;

        const distance = Math.sqrt(
          Math.pow(endPoint.x - startPoint.x, 2) + Math.pow(endPoint.y - startPoint.y, 2)
        );
        if (distance >= MIN_DRAG_DISTANCE) {
          const newRange = createRangeFromPoints(doc, startPoint, endPoint);
          if (newRange) {
            const selectedText = getTextFromRange(newRange).trim();
            const cfi = view.getCFI?.(index, newRange) ?? "";
            if (selectedText && cfi) {
              const rect = newRange.getBoundingClientRect();
              onSelection({
                selectedText,
                cfi,
                anchorX: rect.left + rect.width / 2,
                anchorY: rect.top,
              });
              return true;
            }
          }
        }
      } else {
        startPointRef.current = null;
        startDocRef.current = null;
      }

      // Path 2: no drag or drag failed — sync from document selection (double-click, shift+click, keyboard)
      if (!view) return false;
      const sel = doc.getSelection?.();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (!range.collapsed) {
          const selectedText = getTextFromRange(range).trim();
          if (selectedText) {
            const cfi = view.getCFI?.(index, range) ?? "";
            if (cfi) {
              const rect = range.getBoundingClientRect();
              onSelection({
                selectedText,
                cfi,
                anchorX: rect.left + rect.width / 2,
                anchorY: rect.top,
              });
              return true;
            }
          }
        }
      }
      return false;
    },
    [viewRef, createRangeFromPoints, onSelection]
  );

  const cancelInstantAnnotation = useCallback(() => {
    startPointRef.current = null;
    startDocRef.current = null;
  }, []);

  return {
    handleInstantAnnotationPointerDown,
    handleInstantAnnotationPointerMove,
    handleInstantAnnotationPointerCancel,
    handleInstantAnnotationPointerUp,
    cancelInstantAnnotation,
    selectionGestureStartedRef,
  };
}
