import { useEffect, useRef } from "react";
import { debounce } from "../utils/debounce";

export type ScrollSource = "touch" | "mouse";

export function useMouseEvent(
  bookKey: string,
  viewRef: React.RefObject<{ prev: (d?: number) => void; next: (d?: number) => void } | null>,
  handlePageFlip: (msg: MessageEvent | React.MouseEvent<HTMLDivElement, MouseEvent>) => void
) {
  const debounceFlip = debounce(handlePageFlip, 100);
  const scrollDebounce = debounce(
    (_source: ScrollSource, delta: number) => {
      const view = viewRef.current;
      if (!view) return;
      if (delta > 0) view.next(Math.abs(delta));
      else view.prev(Math.abs(delta));
    },
    500
  );

  const handleMouseEvent = (
    msg: MessageEvent | React.MouseEvent<HTMLDivElement, MouseEvent>
  ) => {
    if (msg instanceof MessageEvent) {
      if (!msg.data || msg.data.bookKey !== bookKey) return;
      if (msg.data.type === "iframe-wheel") {
        scrollDebounce("mouse", -msg.data.deltaY);
        if (!msg.data.ctrlKey) debounceFlip(msg);
      } else {
        handlePageFlip(msg);
      }
    } else if (msg.type === "wheel") {
      const ev = msg as React.WheelEvent<HTMLDivElement>;
      scrollDebounce("mouse", -ev.deltaY);
    } else {
      handlePageFlip(msg);
    }
  };

  useEffect(() => {
    window.addEventListener("message", handleMouseEvent);
    return () => window.removeEventListener("message", handleMouseEvent);
  }, [bookKey]);

  return { onClick: handlePageFlip, onWheel: handleMouseEvent };
}

interface IframeTouch {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

interface IframeTouchEvent {
  timeStamp: number;
  targetTouches: IframeTouch[];
}

export function useTouchEvent(
  bookKey: string,
  viewRef: React.RefObject<{ prev: (d?: number) => void; next: (d?: number) => void } | null>,
  handlePageFlip: (msg: CustomEvent) => void
) {
  const touchStartRef = useRef<IframeTouch | null>(null);
  const touchEndRef = useRef<IframeTouch | null>(null);

  const onTouchStart = (e: IframeTouchEvent | React.TouchEvent<HTMLDivElement>) => {
    const touch = e.targetTouches[0];
    if (touch) touchStartRef.current = touch;
  };

  const onTouchMove = (e: IframeTouchEvent | React.TouchEvent<HTMLDivElement>) => {
    const touch = e.targetTouches[0];
    if (touch) touchEndRef.current = touch;
  };

  const onTouchEnd = (e: IframeTouchEvent | React.TouchEvent<HTMLDivElement>) => {
    const touch = e.targetTouches[0];
    if (touch) touchEndRef.current = touch;
    const start = touchStartRef.current;
    const end = touchEndRef.current;
    if (start && end) {
      const deltaY = end.screenY - start.screenY;
      const deltaX = end.screenX - start.screenX;
      handlePageFlip(
        new CustomEvent("touch-swipe", {
          detail: { deltaX, deltaY, startX: start.screenX, startY: start.screenY, endX: end.screenX, endY: end.screenY },
        })
      );
      const view = viewRef.current;
      if (view && Math.abs(deltaY) > 30) {
        if (deltaY > 0) view.prev(Math.abs(deltaY));
        else view.next(Math.abs(deltaY));
      }
    }
    touchStartRef.current = null;
    touchEndRef.current = null;
  };

  const handleTouch = (msg: MessageEvent) => {
    if (!msg.data || msg.data.bookKey !== bookKey) return;
    if (msg.data.type === "iframe-touchstart") onTouchStart(msg.data);
    else if (msg.data.type === "iframe-touchmove") onTouchMove(msg.data);
    else if (msg.data.type === "iframe-touchend") onTouchEnd(msg.data);
  };

  useEffect(() => {
    window.addEventListener("message", handleTouch);
    return () => window.removeEventListener("message", handleTouch);
  }, [bookKey]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
