/**
 * Highlight color helpers for the annotator. Minimal — no settings store.
 */
import type { HighlightColor } from "@/types/book";

export const HIGHLIGHT_COLOR_HEX: Record<string, string> = {
  red: "#f87171",
  yellow: "#fde047",
  green: "#86efac",
  blue: "#93c5fd",
  pink: "#f9a8d4",
  violet: "#c4b5fd",
};

export function getHighlightColorHex(color?: HighlightColor): string | undefined {
  if (!color) return undefined;
  if (color.startsWith("#")) return color;
  return HIGHLIGHT_COLOR_HEX[color];
}
