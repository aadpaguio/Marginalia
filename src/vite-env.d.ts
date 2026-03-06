/// <reference types="vite/client" />

declare module "foliate-js/view.js";
declare module "foliate-js/epubcfi.js" {
  export function collapse(cfi: string, toEnd?: boolean): string;
  export function compare(a: string, b: string): number;
}
