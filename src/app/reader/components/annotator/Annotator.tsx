/**
 * Minimal Annotator: subscribes to the view's draw-annotation and draws highlight overlays.
 * No popups, sync, or tools — just CFI-based highlight drawing via foliate-js Overlayer.
 */
import React, { useEffect, useCallback } from "react";
import { Overlayer } from "foliate-js/overlayer.js";
import type { FoliateView } from "@/types/view";
import type { BookNote } from "@/types/book";
import { getHighlightColorHex } from "../../utils/annotatorUtil";

type Props = {
  view: FoliateView | null;
  notes: BookNote[];
};

export default function Annotator({ view, notes: _notes }: Props) {
  const onDrawAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent).detail as {
      draw: (fn: (rects: unknown[], opts?: object) => SVGElement, opts?: object) => void;
      annotation: BookNote & { value?: string };
      doc: Document;
      range: Range;
    };
    const { draw, annotation } = detail;
    const hexColor = getHighlightColorHex(annotation.color) ?? "#fde047";
    draw(Overlayer.highlight, { color: hexColor });
  }, []);

  useEffect(() => {
    if (!view) return;
    view.addEventListener("draw-annotation", onDrawAnnotation);
    return () => view.removeEventListener("draw-annotation", onDrawAnnotation);
  }, [view, onDrawAnnotation]);

  return null;
}
