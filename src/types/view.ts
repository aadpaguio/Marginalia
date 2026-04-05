import type { BookDoc } from "@/libs/document";

/**
 * Foliate-js `View.history`: stack of discrete navigations (TOC, links, goToFraction).
 * Page turns update the current entry via replaceState; see foliate-js/view.js.
 */
export interface FoliateReadingHistory {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  back: () => void;
  forward: () => void;
  clear: () => void;
  addEventListener(
    type: "index-change",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener(
    type: "index-change",
    listener: EventListener,
    options?: boolean | EventListenerOptions
  ): void;
}

/** Minimal FoliateView interface for barebones reader (foliate-js custom element). */
export interface FoliateView extends HTMLElement {
  open: (book: BookDoc) => Promise<void>;
  close: () => void;
  init?: (options: { lastLocation: string }) => void;
  goTo: (href: string) => Promise<void>;
  goToFraction: (fraction: number) => void;
  prev: (distance?: number) => void;
  next: (distance?: number) => void;
  getCFI?: (index: number, range: Range) => string;
  addAnnotation?: (annotation: { value: string; [key: string]: unknown }, remove?: boolean) => Promise<{ index: number; label: string } | undefined>;
  history: FoliateReadingHistory;
  book: BookDoc;
  renderer: {
    scrolled?: boolean;
    setStyles?: (css: string) => void;
    setAttribute: (name: string, value: string | number) => void;
    removeAttribute: (name: string) => void;
    next: () => Promise<void>;
    prev: () => Promise<void>;
    addEventListener: (
      type: string,
      listener: EventListener,
      option?: AddEventListenerOptions
    ) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
    getContents: () => { doc: Document; index?: number }[];
  };
}
