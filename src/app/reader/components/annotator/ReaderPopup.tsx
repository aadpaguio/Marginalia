import { useEffect, useRef, type ReactNode } from "react";

export type ReaderPopupProps = {
  /** Panel position relative to offset parent (e.g. reader container). */
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  /** Horizontal center of the caret triangle, in the same coordinate system as `left` (typically anchor X in container space). */
  anchorX: number;
  /** Triangle points up toward the selection (panel sits below) or down (panel sits above). */
  trianglePoints: "up" | "down";
  isDark: boolean;
  onDismiss?: () => void;
  children: ReactNode;
};

/**
 * Anchored floating panel with a small triangle, Escape to close.
 * Coordinates are relative to the same positioned parent as the selection toolbar.
 */
export default function ReaderPopup({
  left,
  top,
  width,
  maxHeight,
  anchorX,
  trianglePoints,
  isDark,
  onDismiss,
  children,
}: ReaderPopupProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!onDismiss) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss]);

  const panelBg = isDark ? "rgba(26, 24, 20, 0.98)" : "rgba(250, 246, 238, 0.99)";
  const panelBorder = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(30, 24, 14, 0.12)";
  const shadow = isDark ? "0 12px 32px rgba(0,0,0,0.45)" : "0 10px 24px rgba(30, 24, 14, 0.18)";

  const triSize = 7;
  const triOffset = Math.round(
    Math.max(triSize + 2, Math.min(width - triSize - 2, anchorX - left - triSize))
  );

  return (
    <div
      ref={rootRef}
      className="marginalia-reader-popup"
      style={{
        position: "absolute",
        left,
        top,
        width,
        zIndex: 126,
        fontFamily: "var(--font-ui, system-ui, sans-serif)",
      }}
    >
      {trianglePoints === "up" && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: triOffset,
            top: -triSize + 1,
            width: 0,
            height: 0,
            borderLeft: `${triSize}px solid transparent`,
            borderRight: `${triSize}px solid transparent`,
            borderBottom: `${triSize}px solid ${panelBg}`,
            filter: isDark ? "drop-shadow(0 -1px 0 rgba(255,255,255,0.08))" : undefined,
          }}
        />
      )}
      <div
        style={{
          borderRadius: 10,
          border: `1px solid ${panelBorder}`,
          background: panelBg,
          boxShadow: shadow,
          maxHeight,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      {trianglePoints === "down" && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: triOffset,
            bottom: -triSize + 1,
            width: 0,
            height: 0,
            borderLeft: `${triSize}px solid transparent`,
            borderRight: `${triSize}px solid transparent`,
            borderTop: `${triSize}px solid ${panelBg}`,
          }}
        />
      )}
    </div>
  );
}
