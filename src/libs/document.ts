/**
 * Minimal document loader for EPUB. Returns a BookDoc compatible with foliate-js view.open().
 * Based on Readest’s libs/document.ts; EPUB path only.
 */
import type { BookFormat } from "@/types/book";

export type Location = {
  current: number;
  next: number;
  total: number;
};

export interface TOCItem {
  id: number;
  label: string;
  href: string;
  index: number;
  cfi?: string;
  location?: Location;
  subitems?: TOCItem[];
}

export interface SectionItem {
  id: string;
  cfi: string;
  size: number;
  linear: string;
  href?: string;
  location?: Location;
  pageSpread?: "left" | "right" | "center" | "";
  subitems?: SectionItem[];
  createDocument: () => Promise<Document>;
}

export interface BookMetadata {
  title: string;
  author: string;
  language?: string | string[];
  [key: string]: unknown;
}

export interface BookDoc {
  metadata: BookMetadata;
  rendition?: {
    layout?: "pre-paginated" | "reflowable";
    spread?: "auto" | "none";
    viewport?: { width: number; height: number };
  };
  dir: string;
  toc?: TOCItem[];
  sections?: SectionItem[];
  transformTarget?: EventTarget;
  splitTOCHref(href: string): Array<string | number>;
  getCover(): Promise<Blob | null>;
}

function configureZip(): Promise<void> {
  return import("@zip.js/zip.js").then((zip) => {
    zip.configure({ useWebWorkers: false, useCompressionStream: false });
  });
}

export class DocumentLoader {
  private file: File;

  constructor(file: File) {
    this.file = file;
  }

  private async makeZipLoader(): Promise<{
    loadText: (name: string) => Promise<string | null>;
    loadBlob: (name: string, type?: string) => Promise<Blob | null>;
    getSize: (name: string) => number;
  }> {
    await configureZip();
    const { ZipReader, BlobReader, TextWriter, BlobWriter } = await import(
      "@zip.js/zip.js"
    );
    type Entry = import("@zip.js/zip.js").Entry;
    const reader = new ZipReader(new BlobReader(this.file));
    const entries = await reader.getEntries();
    const map = new Map<string, Entry>(entries.map((e) => [e.filename, e]));

    const loadText = async (name: string): Promise<string | null> => {
      const entry = map.get(name);
      if (!entry || entry.directory) return null;
      return entry.getData!(new TextWriter()) as Promise<string>;
    };

    const loadBlob = async (
      name: string,
      type?: string
    ): Promise<Blob | null> => {
      const entry = map.get(name);
      if (!entry || entry.directory) return null;
      return entry.getData!(new BlobWriter(type)) as Promise<Blob>;
    };

    const getSize = (name: string): number =>
      map.get(name)?.uncompressedSize ?? 0;

    return { loadText, loadBlob, getSize };
  }

  public async open(): Promise<{ book: BookDoc; format: BookFormat }> {
    if (!this.file.size) throw new Error("File is empty");

    const arr = new Uint8Array(await this.file.slice(0, 4).arrayBuffer());
    const isZip =
      arr[0] === 0x50 &&
      arr[1] === 0x4b &&
      arr[2] === 0x03 &&
      arr[3] === 0x04;
    if (!isZip) throw new Error("Not a valid EPUB (expected ZIP)");

    const loader = await this.makeZipLoader();
    const { EPUB } = await import("foliate-js/epub.js");
    const book = (await new EPUB(loader).init()) as unknown as BookDoc;
    return { book, format: "EPUB" };
  }
}
