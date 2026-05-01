/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" in dev (`npm run tauri:dev`) to show benchmark / evaluation UI. Omit in installable builds. */
  readonly VITE_ENABLE_EVAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "foliate-js/view.js";
declare module "foliate-js/overlayer.js";
declare module "foliate-js/epub.js";
declare module "foliate-js/epubcfi.js" {
  export function collapse(cfi: string, toEnd?: boolean): string;
  export function compare(a: string, b: string): number;
}
