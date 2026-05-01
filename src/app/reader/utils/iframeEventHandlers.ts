/** Inline constants (no @/services/constants). */
const DOUBLE_CLICK_INTERVAL_MS = 400;
const LONG_HOLD_THRESHOLD_MS = 500;

let lastClickTime = 0;
let longHoldTimeout: ReturnType<typeof setTimeout> | null = null;

const getKeyStatus = (event?: MouseEvent | WheelEvent | TouchEvent | KeyboardEvent) => {
  if (event && "ctrlKey" in event) {
    return {
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };
  }
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
};

export function handleKeydown(bookKey: string, event: KeyboardEvent) {
  window.postMessage(
    {
      type: "iframe-keydown",
      bookKey,
      key: event.key,
      code: event.code,
      ...getKeyStatus(event),
    },
    "*"
  );
}

export function handleKeyup(bookKey: string, event: KeyboardEvent) {
  window.postMessage(
    {
      type: "iframe-keyup",
      bookKey,
      key: event.key,
      code: event.code,
      ...getKeyStatus(event),
    },
    "*"
  );
}

export function handleMousedown(bookKey: string, event: MouseEvent) {
  longHoldTimeout = setTimeout(() => {
    longHoldTimeout = null;
  }, LONG_HOLD_THRESHOLD_MS);
  window.postMessage(
    {
      type: "iframe-mousedown",
      bookKey,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      ...getKeyStatus(event),
    },
    "*"
  );
}

export function handleMouseup(bookKey: string, event: MouseEvent) {
  window.postMessage(
    {
      type: "iframe-mouseup",
      bookKey,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      ...getKeyStatus(event),
    },
    "*"
  );
}

export function handleWheel(bookKey: string, event: WheelEvent) {
  window.postMessage(
    {
      type: "iframe-wheel",
      bookKey,
      deltaY: event.deltaY,
      deltaX: event.deltaX,
      ...getKeyStatus(event),
    },
    "*"
  );
}

export function handleClick(
  bookKey: string,
  doubleClickDisabled: { current: boolean },
  event: MouseEvent
) {
  const now = Date.now();
  if (
    !doubleClickDisabled.current &&
    now - lastClickTime < DOUBLE_CLICK_INTERVAL_MS
  ) {
    lastClickTime = now;
    window.postMessage(
      { type: "iframe-double-click", bookKey, clientX: event.clientX, clientY: event.clientY },
      "*"
    );
    return;
  }
  lastClickTime = now;
  if (!longHoldTimeout) return;
  window.postMessage(
    {
      type: "iframe-single-click",
      bookKey,
      clientX: event.clientX,
      clientY: event.clientY,
      ...getKeyStatus(event),
    },
    "*"
  );
}

function handleTouchEv(bookKey: string, event: TouchEvent, type: string) {
  const touch = event.targetTouches[0];
  const touches = touch
    ? [{ clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY }]
    : [];
  window.postMessage(
    { type, bookKey, timeStamp: Date.now(), targetTouches: touches, ...getKeyStatus(event) },
    "*"
  );
}

export function handleTouchStart(bookKey: string, event: TouchEvent) {
  handleTouchEv(bookKey, event, "iframe-touchstart");
}

export function handleTouchMove(bookKey: string, event: TouchEvent) {
  handleTouchEv(bookKey, event, "iframe-touchmove");
}

export function handleTouchEnd(bookKey: string, event: TouchEvent) {
  handleTouchEv(bookKey, event, "iframe-touchend");
}
