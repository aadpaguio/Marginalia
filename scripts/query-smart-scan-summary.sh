#!/usr/bin/env bash
# Query Marginalia SQLite DB for Smart Scan book summary and section summaries.
# DB location (macOS): ~/Library/Application Support/app.marginalia.reader/marginalia/marginalia.db

set -e
DB_DIR="${HOME}/Library/Application Support/app.marginalia.reader/marginalia"
DB="${DB_DIR}/marginalia.db"

if [[ ! -f "$DB" ]]; then
  echo "DB not found: $DB"
  echo "Run Marginalia at least once and ensure the app has created the DB."
  exit 1
fi

echo "=== Books (id, title, smart_scan_status) ==="
sqlite3 -header -column "$DB" \
  "SELECT id, title, COALESCE(smart_scan_status, 'none') AS smart_scan_status FROM books ORDER BY COALESCE(last_opened_at, added_at) DESC;"

echo ""
echo "=== Book summary (most recently scanned book with a summary) ==="
BOOK_ROW=$(sqlite3 "$DB" "SELECT id, title FROM books WHERE (book_summary IS NOT NULL AND book_summary != '') ORDER BY COALESCE(last_opened_at, added_at) DESC LIMIT 1;")
if [[ -z "$BOOK_ROW" ]]; then
  echo "No book with a stored summary found."
  exit 0
fi
BOOK_ID=$(echo "$BOOK_ROW" | cut -d'|' -f1)
BOOK_TITLE=$(echo "$BOOK_ROW" | cut -d'|' -f2)
echo "Book: $BOOK_TITLE (id: $BOOK_ID)"
echo "---"
sqlite3 "$DB" "SELECT book_summary FROM books WHERE id = '$BOOK_ID';"
echo ""
echo "=== Section summaries for this book (full text) ==="
sqlite3 "$DB" "
SELECT '--- Section ' || (spine_index + 1) || ': ' || COALESCE(toc_label, spine_href) || ' [' || structure_type || '] ---' || char(10) || summary || char(10)
FROM section_summaries
WHERE book_id = '$BOOK_ID'
ORDER BY spine_index;
"
