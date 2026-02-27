import type { MouseEvent } from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { Plus, Settings, Sparkles } from "lucide-react";
import type { StoredBook } from "@/services/db";
import styles from "./Library.module.css";

type LibraryBook = StoredBook & {
  coverDataUrl?: string | null;
  isMissingFile?: boolean;
};

type Props = {
  books: LibraryBook[];
  onOpenBook: () => void;
  onSelectBook: (book: LibraryBook) => void;
  onDeleteBook: (book: LibraryBook) => void;
  openingBookId?: string | null;
  onScanBook?: (book: LibraryBook) => void;
  onClearScanData?: () => void | Promise<void>;
  onSettingsClick?: () => void;
};

export default function Library({
  books,
  onOpenBook,
  onSelectBook,
  onDeleteBook,
  openingBookId,
  onScanBook,
  onClearScanData,
  onSettingsClick,
}: Props) {
  const handleContextMenu = async (e: MouseEvent, book: LibraryBook) => {
    e.preventDefault();
    const deleteItem = await MenuItem.new({
      text: "Remove from library",
      action: () => {
        if (window.confirm(`Remove "${book.title}" from the library? Your file won't be deleted.`)) {
          onDeleteBook(book);
        }
      },
    });
    const menu = await Menu.new({ items: [deleteItem] });
    await menu.popup();
  };

  const topBar = (
    <header className={styles.topBar}>
      <div className={styles.brand}>
        <h1 className={styles.appName}>Marginalia</h1>
        <p className={styles.subtitle}>Your library</p>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btnOpenBook}
          onClick={onOpenBook}
          title="Import book"
          aria-label="Import book"
        >
          <Plus size={18} />
        </button>
        <button
          type="button"
          className={styles.btnGhost}
          onClick={onSettingsClick}
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );

  if (books.length === 0) {
    return (
      <div className={styles.root}>
        {topBar}
        <div className={styles.emptyWrap}>
          <div className={styles.emptyInner}>
            <h2 className={styles.emptyTitle}>No books yet</h2>
            <p className={styles.emptyText}>Import your first EPUB to start reading.</p>
            <button type="button" className={styles.emptyButton} onClick={onOpenBook}>
              Open Book
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {topBar}
      <div className={styles.gridWrap}>
        <div className={styles.grid}>
          {books.map((book) => {
            const progress = Math.max(0, Math.min(1, book.progressFraction || 0));
            const isOpening = openingBookId === book.id;
            const isDisabled = book.isMissingFile || isOpening;
            const isScanDone = book.smartScanStatus === "done";
            const isScanning = book.smartScanStatus === "in_progress";
            return (
              <div
                key={book.id}
                className={[styles.card, isDisabled && styles.cardDisabled].filter(Boolean).join(" ")}
                onContextMenu={(e) => void handleContextMenu(e, book)}
              >
                <button
                  type="button"
                  className={styles.cardButton}
                  disabled={isDisabled}
                  onClick={() => onSelectBook(book)}
                >
                  <div className={styles.coverWrap}>
                    {book.coverDataUrl ? (
                      <img
                        src={book.coverDataUrl}
                        alt=""
                        className={styles.coverImg}
                      />
                    ) : (
                      <div className={styles.coverPlaceholder}>
                        <span className={styles.coverPlaceholderText}>{book.title || "No title"}</span>
                      </div>
                    )}
                  </div>
                  <div className={styles.meta}>
                    <div className={styles.title}>{book.title || "Untitled"}</div>
                    <div className={styles.author}>{book.author || "Unknown author"}</div>
                    {book.isMissingFile && <div className={styles.missingFile}>File not found</div>}
                    <div className={styles.progressTrack}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                  </div>
                </button>
                {onScanBook && !book.isMissingFile && (
                  <button
                    type="button"
                    className={[styles.scanButton, isScanDone && styles.scanButtonDone].filter(Boolean).join(" ")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onScanBook(book);
                    }}
                    disabled={isScanning}
                    aria-label={
                      isScanDone ? "Smart Scan complete · Re-scan" : isScanning ? "Scanning…" : "Run Smart Scan"
                    }
                    title={
                      isScanDone ? "Smart Scan complete · Re-scan" : isScanning ? "Scanning…" : "Run Smart Scan"
                    }
                  >
                    <Sparkles size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
