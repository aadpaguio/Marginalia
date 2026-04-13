import type { MouseEvent } from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { Loader2, Plus, Settings } from "lucide-react";
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

  const anyScanInProgress = books.some((b) => b.smartScanStatus === "in_progress");

  const topBar = (
    <header className={styles.topBar}>
      <div className={styles.brand}>
        <h1 className={styles.appName}>Marginalia</h1>
        <p className={styles.subtitle}>Your library</p>
        {anyScanInProgress && (
          <p className={styles.homeScanHint} role="status" aria-live="polite">
            <Loader2 className={styles.homeScanHintIcon} size={12} strokeWidth={2.25} aria-hidden />
            <span>Smart Scan running in the background</span>
          </p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btnAddBook}
          onClick={onOpenBook}
          title="Import book"
          aria-label="Add book"
        >
          <Plus size={14} />
          <span>Add book</span>
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
            const scanDone = book.smartScanStatus === "done";
            const scanInProgress = book.smartScanStatus === "in_progress";
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
                  aria-busy={scanInProgress || undefined}
                  aria-label={scanInProgress ? `${book.title || "Book"}, Smart Scan in progress` : undefined}
                >
                  <div
                    className={`${styles.coverWrap} ${scanDone ? styles.scanned : ""} ${scanInProgress ? styles.scanning : ""}`}
                    title={
                      scanDone ? "Smart-Scanned" : scanInProgress ? "Smart Scan in progress — continues in the background" : undefined
                    }
                  >
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
                    {scanInProgress && (
                      <div className={styles.scanChip} aria-hidden>
                        <Loader2 className={styles.scanChipIcon} size={13} strokeWidth={2.25} />
                        <span>Smart Scan</span>
                      </div>
                    )}
                  </div>
                  <div className={styles.meta}>
                    <div className={styles.title}>{book.title || "Untitled"}</div>
                    {book.author && book.author !== "Unknown" && (
                      <div className={styles.author}>{book.author}</div>
                    )}
                    {book.isMissingFile && <div className={styles.missingFile}>File not found</div>}
                    <div className={styles.progressTrack}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
