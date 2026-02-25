import type { BookDoc } from "@/libs/document";

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
