import { useState } from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { Sparkles } from "lucide-react";
import type { StoredBook } from "@/services/db";

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
};

export default function Library({ books, onOpenBook, onSelectBook, onDeleteBook, openingBookId, onScanBook, onClearScanData }: Props) {
  const [hoveredBookId, setHoveredBookId] = useState<string | null>(null);

  const handleContextMenu = async (e: React.MouseEvent, book: LibraryBook) => {
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
  if (books.length === 0) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 520 }}>
          <h1 style={{ marginBottom: 12 }}>Library</h1>
          <p style={{ color: "#666", marginBottom: 16 }}>No books yet. Import your first EPUB.</p>
          <button type="button" onClick={onOpenBook} style={{ padding: "10px 16px", cursor: "pointer" }}>
            Import EPUB...
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Library</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {onClearScanData && (
            <button
              type="button"
              onClick={() => void onClearScanData()}
              style={{ padding: "6px 10px", cursor: "pointer", fontSize: 12, color: "#666" }}
              title="Delete all Smart Scan data and reset scan status for every book"
            >
              Clear Smart Scan data
            </button>
          )}
          <button type="button" onClick={onOpenBook} style={{ padding: "8px 12px", cursor: "pointer" }}>
            Import EPUB...
          </button>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
          gap: 14,
        }}
      >
        {books.map((book) => {
          const progress = Math.max(0, Math.min(1, book.progressFraction || 0));
          const isOpening = openingBookId === book.id;
          const isHovered = hoveredBookId === book.id;
          return (
            <div
              key={book.id}
              onMouseEnter={() => setHoveredBookId(book.id)}
              onMouseLeave={() => setHoveredBookId(null)}
              onContextMenu={(e) => void handleContextMenu(e, book)}
              style={{
                position: "relative",
                textAlign: "left",
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 10,
                padding: 8,
                background: isHovered ? "rgba(0,0,0,0.04)" : "#fff",
                boxShadow: isHovered ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                opacity: book.isMissingFile ? 0.65 : 1,
                transition: "background 0.15s ease, box-shadow 0.15s ease",
              }}
            >
              <button
                type="button"
                disabled={book.isMissingFile || isOpening}
                onClick={() => onSelectBook(book)}
                style={{
                  width: "100%",
                  padding: 0,
                  border: "none",
                  background: "none",
                  cursor: book.isMissingFile ? "not-allowed" : "pointer",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    aspectRatio: "3 / 4",
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "#f2f2f2",
                    marginBottom: 8,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  {book.coverDataUrl ? (
                    <img
                      src={book.coverDataUrl}
                      alt={`${book.title} cover`}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <span style={{ color: "#777", fontSize: 12, padding: 8 }}>No cover</span>
                  )}
                </div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3, lineHeight: 1.35 }}>{book.title}</div>
                <div style={{ color: "#666", fontSize: 12, marginBottom: 6 }}>{book.author || "Unknown"}</div>
                {book.isMissingFile && <div style={{ color: "#9b2c2c", fontSize: 11, marginBottom: 4 }}>File not found</div>}
                <div style={{ height: 4, borderRadius: 999, background: "rgba(0,0,0,0.1)", overflow: "hidden" }}>
                  <div style={{ width: `${Math.round(progress * 100)}%`, height: "100%", background: "#1f6feb" }} />
                </div>
              </button>
              {onScanBook && !book.isMissingFile && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onScanBook(book);
                  }}
                  aria-label={
                    book.smartScanStatus === "done"
                      ? "Smart Scan complete · Re-scan"
                      : book.smartScanStatus === "in_progress"
                        ? "Scanning…"
                        : "Run Smart Scan"
                  }
                  title={
                    book.smartScanStatus === "done"
                      ? "Smart Scan complete · Re-scan"
                      : book.smartScanStatus === "in_progress"
                        ? "Scanning…"
                        : "Run Smart Scan"
                  }
                  disabled={book.smartScanStatus === "in_progress"}
                  style={{
                    position: "absolute",
                    bottom: 32,
                    right: 8,
                    width: 24,
                    height: 24,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid rgba(0,0,0,0.12)",
                    borderRadius: 6,
                    background: book.smartScanStatus === "done" ? "rgba(31,111,235,0.1)" : "rgba(255,255,255,0.9)",
                    color: book.smartScanStatus === "done" ? "#1f6feb" : book.smartScanStatus === "in_progress" ? "#999" : "#555",
                    cursor: book.smartScanStatus === "in_progress" ? "default" : "pointer",
                    opacity: book.smartScanStatus === "in_progress" ? 0.6 : 1,
                    padding: 0,
                  }}
                >
                  <Sparkles size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

