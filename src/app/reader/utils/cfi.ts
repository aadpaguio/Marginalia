/**
 * CFI (Canonical Fragment Identifier) helpers for the reader.
 * Uses foliate-js/epubcfi.js for range comparison (same approach as Readest).
 */

import * as CFI from "foliate-js/epubcfi.js";

/**
 * Returns true if two CFI ranges overlap (share any character).
 * Each cfi string can be a point or a range (start,end).
 */
export function cfiRangesOverlap(cfiA: string, cfiB: string): boolean {
  try {
    const startA = CFI.collapse(cfiA, false);
    const endA = CFI.collapse(cfiA, true);
    const startB = CFI.collapse(cfiB, false);
    const endB = CFI.collapse(cfiB, true);
    return CFI.compare(startA, endB) <= 0 && CFI.compare(startB, endA) <= 0;
  } catch {
    return false;
  }
}
