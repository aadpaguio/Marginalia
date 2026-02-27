use std::path::Path;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Read file at path and return contents as base64 (for EPUB bytes).
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    eprintln!("[read_file_base64] start path={}", path.display());
    if !path.is_file() {
        eprintln!("[read_file_base64] not a file");
        return Err("Path is not a file".into());
    }
    let bytes = std::fs::read(path).map_err(|e| {
        eprintln!("[read_file_base64] read error: {}", e);
        e.to_string()
    })?;
    eprintln!("[read_file_base64] read {} bytes", bytes.len());
    let encoded = STANDARD.encode(&bytes);
    eprintln!("[read_file_base64] encoded length {}", encoded.len());
    Ok(encoded)
}

struct DbState {
    db_path: PathBuf,
}

struct MemoryState {
    base_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbBookInput {
    id: String,
    title: String,
    author: Option<String>,
    file_path: String,
    cover_path: Option<String>,
    last_read_cfi: Option<String>,
    progress_fraction: Option<f64>,
    added_at: Option<i64>,
    last_opened_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbBook {
    id: String,
    title: String,
    author: Option<String>,
    file_path: String,
    cover_path: Option<String>,
    last_read_cfi: Option<String>,
    progress_fraction: f64,
    added_at: i64,
    last_opened_at: Option<i64>,
    smart_scan_status: String,
    book_summary: Option<String>,
    book_structure_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbSectionSummary {
    id: String,
    book_id: String,
    spine_href: String,
    spine_index: i64,
    toc_label: Option<String>,
    summary: String,
    char_count: i64,
    estimated_tokens: i64,
    structure_type: String,
    entry_count: Option<i64>,
    radius_snippet: i64,
    radius_section: i64,
    radius_full: i64,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbSectionSummaryInput {
    id: String,
    book_id: String,
    spine_href: String,
    spine_index: i64,
    toc_label: Option<String>,
    summary: String,
    char_count: i64,
    estimated_tokens: i64,
    structure_type: String,
    entry_count: Option<i64>,
    radius_snippet: i64,
    radius_section: i64,
    radius_full: i64,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbBookmarkInput {
    id: String,
    book_id: String,
    cfi: String,
    chapter_label: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbBookmark {
    id: String,
    book_id: String,
    cfi: String,
    chapter_label: Option<String>,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbHighlightInput {
    id: String,
    book_id: String,
    cfi: String,
    selected_text: String,
    color: String,
    chapter_label: Option<String>,
    chapter_href: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbHighlight {
    id: String,
    book_id: String,
    cfi: String,
    selected_text: String,
    color: String,
    chapter_label: Option<String>,
    chapter_href: Option<String>,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbThreadInput {
    id: String,
    book_id: String,
    title: Option<String>,
    created_at: i64,
    updated_at: i64,
    archived: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbThread {
    id: String,
    book_id: String,
    title: Option<String>,
    created_at: i64,
    updated_at: i64,
    archived: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbThreadMessageInput {
    id: String,
    thread_id: String,
    role: String,
    content: String,
    created_at: i64,
    excerpt_text: Option<String>,
    excerpt_cfi: Option<String>,
    excerpt_chapter: Option<String>,
    excerpt_color: Option<String>,
    excerpt_page: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbThreadMessage {
    id: String,
    thread_id: String,
    role: String,
    content: String,
    created_at: i64,
    excerpt_text: Option<String>,
    excerpt_cfi: Option<String>,
    excerpt_chapter: Option<String>,
    excerpt_color: Option<String>,
    excerpt_page: Option<String>,
}

fn open_db(state: &DbState) -> Result<Connection, String> {
    Connection::open(&state.db_path).map_err(|e| e.to_string())
}

fn init_db(db_path: &Path) -> Result<(), String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS books (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          author TEXT,
          file_path TEXT NOT NULL UNIQUE,
          cover_path TEXT,
          last_read_cfi TEXT,
          progress_fraction REAL NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL,
          last_opened_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          cfi TEXT NOT NULL,
          chapter_label TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON bookmarks(book_id);

        CREATE TABLE IF NOT EXISTS highlights (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          cfi TEXT NOT NULL,
          selected_text TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT 'yellow',
          chapter_label TEXT,
          chapter_href TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_highlights_book_id ON highlights(book_id);

        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          title TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_threads_book_id ON threads(book_id);

        CREATE TABLE IF NOT EXISTS thread_highlights (
          thread_id TEXT NOT NULL,
          highlight_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (thread_id, highlight_id),
          FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
          FOREIGN KEY(highlight_id) REFERENCES highlights(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS thread_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id);

        CREATE TABLE IF NOT EXISTS section_summaries (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          spine_href TEXT NOT NULL,
          spine_index INTEGER NOT NULL,
          toc_label TEXT,
          summary TEXT NOT NULL,
          char_count INTEGER NOT NULL DEFAULT 0,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          structure_type TEXT NOT NULL DEFAULT 'other',
          entry_count INTEGER,
          radius_snippet INTEGER NOT NULL DEFAULT 1500,
          radius_section INTEGER NOT NULL DEFAULT 8000,
          radius_full INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_section_summaries_book_id
          ON section_summaries(book_id);
        "#,
    )
    .map_err(|e| e.to_string())?;

    // Clean slate: drop legacy notes table if present (existing installs)
    let _ = conn.execute_batch(
        "DROP INDEX IF EXISTS idx_notes_book_cfi; DROP INDEX IF EXISTS idx_notes_book_id; DROP TABLE IF EXISTS notes;",
    );

    // Migration: add excerpt columns to thread_messages (ignore if already present)
    let _ = conn.execute("ALTER TABLE thread_messages ADD COLUMN excerpt_text TEXT", ());
    let _ = conn.execute("ALTER TABLE thread_messages ADD COLUMN excerpt_cfi TEXT", ());
    let _ = conn.execute("ALTER TABLE thread_messages ADD COLUMN excerpt_chapter TEXT", ());
    let _ = conn.execute("ALTER TABLE thread_messages ADD COLUMN excerpt_color TEXT", ());
    let _ = conn.execute("ALTER TABLE thread_messages ADD COLUMN excerpt_page TEXT", ());

    // Migration: add Smart Scan columns to books (ignore if already present)
    let _ = conn.execute("ALTER TABLE books ADD COLUMN smart_scan_status TEXT NOT NULL DEFAULT 'none'", ());
    let _ = conn.execute("ALTER TABLE books ADD COLUMN book_summary TEXT", ());
    let _ = conn.execute("ALTER TABLE books ADD COLUMN book_structure_type TEXT", ());

    // Migration: add navigation columns to section_summaries (ignore if already present)
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0", ());
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0", ());
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN structure_type TEXT NOT NULL DEFAULT 'other'", ());
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN entry_count INTEGER", ());
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN radius_snippet INTEGER NOT NULL DEFAULT 1500", ());
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN radius_section INTEGER NOT NULL DEFAULT 8000", ());
    let _ = conn.execute("ALTER TABLE section_summaries ADD COLUMN radius_full INTEGER NOT NULL DEFAULT 0", ());

    Ok(())
}

#[tauri::command]
fn db_get_all_books(state: State<DbState>) -> Result<Vec<DbBook>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, author, file_path, cover_path, last_read_cfi, progress_fraction, added_at, last_opened_at,
                    COALESCE(smart_scan_status, 'none'), book_summary, book_structure_type
             FROM books
             ORDER BY COALESCE(last_opened_at, added_at) DESC, added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DbBook {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                file_path: row.get(3)?,
                cover_path: row.get(4)?,
                last_read_cfi: row.get(5)?,
                progress_fraction: row.get(6)?,
                added_at: row.get(7)?,
                last_opened_at: row.get(8)?,
                smart_scan_status: row.get::<_, Option<String>>(9)?.unwrap_or_else(|| "none".to_string()),
                book_summary: row.get(10)?,
                book_structure_type: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_book(state: State<DbState>, id: String) -> Result<Option<DbBook>, String> {
    let conn = open_db(&state)?;
    conn.query_row(
        "SELECT id, title, author, file_path, cover_path, last_read_cfi, progress_fraction, added_at, last_opened_at,
                COALESCE(smart_scan_status, 'none'), book_summary, book_structure_type
         FROM books WHERE id = ?1",
        params![id],
        |row| {
            Ok(DbBook {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                file_path: row.get(3)?,
                cover_path: row.get(4)?,
                last_read_cfi: row.get(5)?,
                progress_fraction: row.get(6)?,
                added_at: row.get(7)?,
                last_opened_at: row.get(8)?,
                smart_scan_status: row.get::<_, Option<String>>(9)?.unwrap_or_else(|| "none".to_string()),
                book_summary: row.get(10)?,
                book_structure_type: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_book(state: State<DbState>, book: serde_json::Value) -> Result<(), String> {
    let book: DbBookInput = match book {
        serde_json::Value::String(s) => serde_json::from_str(&s).map_err(|e| e.to_string())?,
        value => serde_json::from_value(value).map_err(|e| e.to_string())?,
    };
    let now = chrono_like_now();
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO books (
          id, title, author, file_path, cover_path, last_read_cfi, progress_fraction, added_at, last_opened_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          file_path = excluded.file_path,
          cover_path = excluded.cover_path,
          last_read_cfi = excluded.last_read_cfi,
          progress_fraction = excluded.progress_fraction,
          last_opened_at = excluded.last_opened_at
        "#,
        params![
            book.id,
            book.title,
            book.author,
            book.file_path,
            book.cover_path,
            book.last_read_cfi,
            book.progress_fraction.unwrap_or(0.0),
            book.added_at.unwrap_or(now),
            book.last_opened_at.or(Some(now)),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_delete_book(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM books WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_highlights(state: State<DbState>, book_id: String) -> Result<Vec<DbHighlight>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, cfi, selected_text, color, chapter_label, chapter_href, created_at
             FROM highlights WHERE book_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(DbHighlight {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                selected_text: row.get(3)?,
                color: row.get(4)?,
                chapter_label: row.get(5)?,
                chapter_href: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_highlight(state: State<DbState>, highlight: DbHighlightInput) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO highlights (id, book_id, cfi, selected_text, color, chapter_label, chapter_href, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
          book_id = excluded.book_id,
          cfi = excluded.cfi,
          selected_text = excluded.selected_text,
          color = excluded.color,
          chapter_label = excluded.chapter_label,
          chapter_href = excluded.chapter_href,
          created_at = excluded.created_at
        "#,
        params![
            highlight.id,
            highlight.book_id,
            highlight.cfi,
            highlight.selected_text,
            highlight.color,
            highlight.chapter_label,
            highlight.chapter_href,
            highlight.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_delete_highlight(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM highlights WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_threads(state: State<DbState>, book_id: String) -> Result<Vec<DbThread>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, title, created_at, updated_at, archived
             FROM threads WHERE book_id = ?1 AND (archived = 0 OR archived IS NULL)
             ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(DbThread {
                id: row.get(0)?,
                book_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                archived: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_create_thread(state: State<DbState>, thread: DbThreadInput) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO threads (id, book_id, title, created_at, updated_at, archived)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            thread.id,
            thread.book_id,
            thread.title,
            thread.created_at,
            thread.updated_at,
            thread.archived.unwrap_or(0),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_update_thread_title(
    state: State<DbState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("UPDATE threads SET title = ?1, updated_at = ?2 WHERE id = ?3", params![title, chrono_like_now(), id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_archive_thread(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("UPDATE threads SET archived = 1, updated_at = ?1 WHERE id = ?2", params![chrono_like_now(), id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_delete_thread(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_thread_messages(
    state: State<DbState>,
    thread_id: String,
) -> Result<Vec<DbThreadMessage>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, thread_id, role, content, created_at, excerpt_text, excerpt_cfi, excerpt_chapter, excerpt_color, excerpt_page
             FROM thread_messages WHERE thread_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![thread_id], |row| {
            Ok(DbThreadMessage {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                excerpt_text: row.get(5)?,
                excerpt_cfi: row.get(6)?,
                excerpt_chapter: row.get(7)?,
                excerpt_color: row.get(8)?,
                excerpt_page: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_save_thread_message(
    state: State<DbState>,
    message: DbThreadMessageInput,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO thread_messages (id, thread_id, role, content, created_at, excerpt_text, excerpt_cfi, excerpt_chapter, excerpt_color, excerpt_page)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            message.id,
            message.thread_id,
            message.role,
            message.content,
            message.created_at,
            message.excerpt_text,
            message.excerpt_cfi,
            message.excerpt_chapter,
            message.excerpt_color,
            message.excerpt_page,
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
        params![message.created_at, message.thread_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_clear_all_threads(state: State<DbState>) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute_batch(
        "DELETE FROM thread_messages; DELETE FROM thread_highlights; DELETE FROM threads;",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_attach_highlight_to_thread(
    state: State<DbState>,
    thread_id: String,
    highlight_id: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    let position: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM thread_highlights WHERE thread_id = ?1",
            params![thread_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO thread_highlights (thread_id, highlight_id, position) VALUES (?1, ?2, ?3)",
        params![thread_id, highlight_id, position],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_standalone_highlights(
    state: State<DbState>,
    book_id: String,
) -> Result<Vec<DbHighlight>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.book_id, h.cfi, h.selected_text, h.color, h.chapter_label, h.chapter_href, h.created_at
             FROM highlights h
             LEFT JOIN thread_highlights th ON th.highlight_id = h.id
             WHERE h.book_id = ?1 AND th.thread_id IS NULL
             ORDER BY h.created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(DbHighlight {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                selected_text: row.get(3)?,
                color: row.get(4)?,
                chapter_label: row.get(5)?,
                chapter_href: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_highlights_for_thread(
    state: State<DbState>,
    thread_id: String,
) -> Result<Vec<DbHighlight>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.book_id, h.cfi, h.selected_text, h.color, h.chapter_label, h.chapter_href, h.created_at
             FROM highlights h
             INNER JOIN thread_highlights th ON th.highlight_id = h.id
             WHERE th.thread_id = ?1
             ORDER BY th.position ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![thread_id], |row| {
            Ok(DbHighlight {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                selected_text: row.get(3)?,
                color: row.get(4)?,
                chapter_label: row.get(5)?,
                chapter_href: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_bookmarks(state: State<DbState>, book_id: String) -> Result<Vec<DbBookmark>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, cfi, chapter_label, created_at
             FROM bookmarks
             WHERE book_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(DbBookmark {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                chapter_label: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_bookmark(state: State<DbState>, bookmark: DbBookmarkInput) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO bookmarks (id, book_id, cfi, chapter_label, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
          book_id = excluded.book_id,
          cfi = excluded.cfi,
          chapter_label = excluded.chapter_label,
          created_at = excluded.created_at
        "#,
        params![
            bookmark.id,
            bookmark.book_id,
            bookmark.cfi,
            bookmark.chapter_label,
            bookmark.created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_delete_bookmark(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_update_reading_progress(
    state: State<DbState>,
    book_id: String,
    cfi: String,
    fraction: f64,
) -> Result<(), String> {
    let now = chrono_like_now();
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE books
         SET last_read_cfi = ?1, progress_fraction = ?2, last_opened_at = ?3
         WHERE id = ?4",
        params![cfi, fraction, now, book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_section_summaries(
    state: State<DbState>,
    book_id: String,
) -> Result<Vec<DbSectionSummary>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, spine_href, spine_index, toc_label, summary,
                    COALESCE(char_count, 0), COALESCE(estimated_tokens, 0),
                    COALESCE(structure_type, 'other'), entry_count,
                    COALESCE(radius_snippet, 1500), COALESCE(radius_section, 8000), COALESCE(radius_full, 0),
                    created_at
             FROM section_summaries WHERE book_id = ?1 ORDER BY spine_index ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(DbSectionSummary {
                id: row.get(0)?,
                book_id: row.get(1)?,
                spine_href: row.get(2)?,
                spine_index: row.get(3)?,
                toc_label: row.get(4)?,
                summary: row.get(5)?,
                char_count: row.get(6)?,
                estimated_tokens: row.get(7)?,
                structure_type: row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "other".to_string()),
                entry_count: row.get(9)?,
                radius_snippet: row.get(10)?,
                radius_section: row.get(11)?,
                radius_full: row.get(12)?,
                created_at: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_section_summary(
    state: State<DbState>,
    summary: DbSectionSummaryInput,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO section_summaries (
          id, book_id, spine_href, spine_index, toc_label, summary,
          char_count, estimated_tokens, structure_type, entry_count,
          radius_snippet, radius_section, radius_full, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
          spine_href = excluded.spine_href,
          spine_index = excluded.spine_index,
          toc_label = excluded.toc_label,
          summary = excluded.summary,
          char_count = excluded.char_count,
          estimated_tokens = excluded.estimated_tokens,
          structure_type = excluded.structure_type,
          entry_count = excluded.entry_count,
          radius_snippet = excluded.radius_snippet,
          radius_section = excluded.radius_section,
          radius_full = excluded.radius_full,
          created_at = excluded.created_at
        "#,
        params![
            summary.id,
            summary.book_id,
            summary.spine_href,
            summary.spine_index,
            summary.toc_label,
            summary.summary,
            summary.char_count,
            summary.estimated_tokens,
            summary.structure_type,
            summary.entry_count,
            summary.radius_snippet,
            summary.radius_section,
            summary.radius_full,
            summary.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_book_scan_status(state: State<DbState>, book_id: String) -> Result<String, String> {
    let conn = open_db(&state)?;
    conn.query_row(
        "SELECT COALESCE(smart_scan_status, 'none') FROM books WHERE id = ?1",
        params![book_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|opt| opt.unwrap_or_else(|| "none".to_string()))
}

#[tauri::command]
fn db_set_book_scan_status(
    state: State<DbState>,
    book_id: String,
    status: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE books SET smart_scan_status = ?1 WHERE id = ?2",
        params![status, book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_book_summary(state: State<DbState>, book_id: String) -> Result<Option<String>, String> {
    let conn = open_db(&state)?;
    conn.query_row(
        "SELECT book_summary FROM books WHERE id = ?1",
        params![book_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|opt| opt.flatten())
}

#[tauri::command]
fn db_set_book_summary(
    state: State<DbState>,
    book_id: String,
    summary: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE books SET book_summary = ?1 WHERE id = ?2",
        params![summary, book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_set_book_structure_type(
    state: State<DbState>,
    book_id: String,
    structure_type: Option<String>,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE books SET book_structure_type = ?1 WHERE id = ?2",
        params![structure_type, book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes all section summaries (Smart Scan section data). Use with db_reset_all_book_scan_data to start scan from scratch.
#[tauri::command]
fn db_delete_all_section_summaries(state: State<DbState>) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM section_summaries", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resets smart_scan_status, book_summary, and book_structure_type for all books.
#[tauri::command]
fn db_reset_all_book_scan_data(state: State<DbState>) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE books SET smart_scan_status = 'none', book_summary = NULL, book_structure_type = NULL",
        (),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_like_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn cleanup_legacy_progress_file() {
    if let Ok(home) = std::env::var("HOME") {
        let legacy = Path::new(&home).join(".marginalia").join("progress.json");
        if legacy.exists() {
            let _ = std::fs::remove_file(legacy);
        }
    }
}

#[tauri::command]
fn save_cover_image(
    state: State<DbState>,
    book_id: String,
    bytes_base64: String,
) -> Result<String, String> {
    let covers_dir = state
        .db_path
        .parent()
        .ok_or_else(|| "Invalid database path".to_string())?
        .join("covers");
    std::fs::create_dir_all(&covers_dir).map_err(|e| e.to_string())?;
    let bytes = STANDARD
        .decode(bytes_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let cover_path = covers_dir.join(format!("{book_id}.jpg"));
    std::fs::write(&cover_path, bytes).map_err(|e| e.to_string())?;
    Ok(cover_path.to_string_lossy().to_string())
}

#[tauri::command]
fn memory_ensure_dirs(state: State<MemoryState>) -> Result<(), String> {
    let books_dir = state.base_path.join("books");
    std::fs::create_dir_all(&state.base_path).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&books_dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn memory_list_books(state: State<MemoryState>) -> Result<Vec<String>, String> {
    let books_dir = state.base_path.join("books");
    if !books_dir.is_dir() {
        return Ok(vec![]);
    }
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(&books_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(stem) = path.file_stem() {
                if let Some(id) = stem.to_str() {
                    ids.push(id.to_string());
                }
            }
        }
    }
    Ok(ids)
}

#[tauri::command]
fn memory_read_book(state: State<MemoryState>, book_id: String) -> Result<Option<String>, String> {
    let path = state.base_path.join("books").join(format!("{}.md", book_id));
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_write_book(
    state: State<MemoryState>,
    book_id: String,
    content: String,
) -> Result<(), String> {
    let books_dir = state.base_path.join("books");
    std::fs::create_dir_all(&books_dir).map_err(|e| e.to_string())?;
    let path = books_dir.join(format!("{}.md", book_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_read_reader(state: State<MemoryState>) -> Result<Option<String>, String> {
    let path = state.base_path.join("reader.md");
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_write_reader(state: State<MemoryState>, content: String) -> Result<(), String> {
    std::fs::create_dir_all(&state.base_path).map_err(|e| e.to_string())?;
    let path = state.base_path.join("reader.md");
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

const MAX_CONTEXT_CHARS: usize = 4000;
const MAX_PASSAGE_CHARS: usize = 4000;
const MAX_HISTORY_MESSAGES: usize = 10;

fn truncate_with_marker(s: &str, max_chars: usize) -> (String, bool) {
    let chars: Vec<char> = s.chars().collect();
    let truncated = chars.len() > max_chars;
    let out: String = chars.into_iter().take(max_chars).collect();
    let out = if truncated {
        format!("{} (truncated)", out)
    } else {
        out
    };
    (out, truncated)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeProxyRequest {
    api_key: String,
    model: String,
    /// Stable rules (behavior, style, spoilers) — cached.
    system_prompt_stable: String,
    /// Session-specific (book title, author) — not cached.
    system_prompt_session: String,
    surrounding_context: String,
    selected_text: String,
    user_message: String,
    conversation_history: Option<Vec<ClaudeHistoryMessage>>,
    /// Max output tokens; default 600. Use 900–1600 for deep analysis.
    #[serde(default)]
    max_tokens: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHistoryMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeThreadSystemBlock {
    text: String,
    cache_control: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeThreadMessage {
    role: String,
    #[serde(default)]
    content: serde_json::Value,
}

/// Minimal request for titling etc.: no passage/context blocks, just system + one user message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSimpleProxyRequest {
    api_key: String,
    model: String,
    system_prompt: String,
    user_message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeThreadProxyRequest {
    api_key: String,
    model: String,
    system_blocks: Vec<ClaudeThreadSystemBlock>,
    messages: Vec<ClaudeThreadMessage>,
    #[serde(default)]
    tools: Option<Vec<serde_json::Value>>,
    /// "auto" | "any" | "none" — maps to Anthropic's tool_choice.type
    #[serde(default)]
    tool_choice: Option<String>,
    /// Optional log prefix (e.g. "smart_scan") so logs are distinguishable from thread chat.
    #[serde(default)]
    log_label: Option<String>,
    /// Max output tokens (default 4096). Use lower values (e.g. 550) for short JSON/summaries to reduce latency and rate-limit pressure.
    #[serde(default)]
    max_tokens: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeUsage {
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeProxyResponse {
    answer: String,
    model: String,
    usage: Option<ClaudeUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeThreadProxyResponse {
    answer: String,
    tool_calls: Vec<serde_json::Value>,
    raw_content: Vec<serde_json::Value>,
    model: String,
    usage: Option<ClaudeUsage>,
}

/// Proxy Claude requests through Rust to avoid WebView network/CORS issues.
#[tauri::command]
async fn ask_claude_proxy(request: ClaudeProxyRequest) -> Result<ClaudeProxyResponse, String> {
    let model = request.model.clone();
    let (surrounding, _) = truncate_with_marker(&request.surrounding_context, MAX_CONTEXT_CHARS);
    let (selected, _) = truncate_with_marker(&request.selected_text, MAX_PASSAGE_CHARS);

    let current_turn_text = format!(
        "Context from the book:\n\n{}\n\nSelected passage:\n\"{}\"\n\n{}",
        surrounding, selected, request.user_message
    );

    let mut messages: Vec<serde_json::Value> = Vec::new();

    if let Some(history) = request.conversation_history {
        let valid: Vec<_> = history
            .into_iter()
            .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty())
            .collect();
        let start = valid.len().saturating_sub(MAX_HISTORY_MESSAGES);
        for message in valid.into_iter().skip(start) {
            messages.push(serde_json::json!({
                "role": message.role,
                "content": [{ "type": "text", "text": message.content }]
            }));
        }
    }

    messages.push(serde_json::json!({
        "role": "user",
        "content": [{ "type": "text", "text": current_turn_text }]
    }));

    let max_tokens = request.max_tokens.unwrap_or(600);
    let system = [
        serde_json::json!({
            "type": "text",
            "text": request.system_prompt_stable,
            "cache_control": { "type": "ephemeral" }
        }),
        serde_json::json!({
            "type": "text",
            "text": request.system_prompt_session
        }),
    ];

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("content-type", "application/json")
        .header("x-api-key", request.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "prompt-caching-2024-07-31")
        .json(&serde_json::json!({
            "model": model.clone(),
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Anthropic request failed ({}): {}", status, body));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let answer = parsed
        .get("content")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<&str>>()
                .join("\n")
        })
        .unwrap_or_default();

    let usage = parsed.get("usage").and_then(|u| u.as_object()).map(|u| ClaudeUsage {
        cache_creation_input_tokens: u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64()),
        cache_read_input_tokens: u.get("cache_read_input_tokens").and_then(|v| v.as_u64()),
        input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()),
        output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()),
    });

    Ok(ClaudeProxyResponse {
        answer,
        model,
        usage,
    })
}

/// Simple proxy for titling: no "Context from the book" or "Selected passage" blocks.
/// Use a titling-specific system prompt so the model doesn't expect passage context.
#[tauri::command]
async fn ask_claude_simple_proxy(request: ClaudeSimpleProxyRequest) -> Result<ClaudeProxyResponse, String> {
    let model = request.model.clone();
    let messages = vec![serde_json::json!({
        "role": "user",
        "content": [{"type": "text", "text": request.user_message}]
    })];

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("content-type", "application/json")
        .header("x-api-key", request.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": model.clone(),
            "max_tokens": 128,
            "system": [{
                "type": "text",
                "text": request.system_prompt
            }],
            "messages": messages
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Anthropic request failed ({}): {}", status, body));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let answer = parsed
        .get("content")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<&str>>()
                .join("\n")
        })
        .unwrap_or_default();

    let usage = parsed.get("usage").and_then(|u| u.as_object()).map(|u| ClaudeUsage {
        cache_creation_input_tokens: u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()),
        cache_read_input_tokens: u.get("cache_read_input_tokens").and_then(|v| v.as_u64()),
        input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()),
        output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()),
    });

    Ok(ClaudeProxyResponse {
        answer,
        model,
        usage,
    })
}

/// Thread-aware proxy: accepts pre-assembled system blocks and messages. Supports tools and
/// structured message content (tool_use / tool_result). Returns answer, tool_calls, raw_content.
fn normalize_message_content(content: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(s) = content.as_str() {
        if s.trim().is_empty() {
            return None;
        }
        return Some(serde_json::json!([{ "type": "text", "text": s }]));
    }
    if let Some(arr) = content.as_array() {
        if arr.is_empty() {
            return None;
        }
        return Some(serde_json::Value::Array(arr.clone()));
    }
    None
}

/// Thread-aware proxy: accepts pre-assembled system blocks (with optional cache) and full messages array.
#[tauri::command]
async fn ask_claude_thread_proxy(
    request: ClaudeThreadProxyRequest,
) -> Result<ClaudeThreadProxyResponse, String> {
    let model = request.model.clone();
    let system: Vec<serde_json::Value> = request
        .system_blocks
        .into_iter()
        .map(|b| {
            let mut block = serde_json::json!({ "type": "text", "text": b.text });
            if b
                .cache_control
                .as_deref()
                .map(|c| c.eq_ignore_ascii_case("ephemeral"))
                .unwrap_or(false)
            {
                block["cache_control"] = serde_json::json!({ "type": "ephemeral" });
            }
            block
        })
        .collect();

    let messages: Vec<serde_json::Value> = request
        .messages
        .into_iter()
        .filter_map(|m| {
            if m.role != "user" && m.role != "assistant" {
                return None;
            }
            let content = normalize_message_content(&m.content)?;
            Some(serde_json::json!({ "role": m.role, "content": content }))
        })
        .collect();

    let max_tokens = request.max_tokens.unwrap_or(4096);
    let mut body = serde_json::json!({
        "model": model.clone(),
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages
    });
    if let Some(ref tools) = request.tools {
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools.clone());
            // Only apply tool_choice when there are tools; default to "auto".
            let tc = request.tool_choice.as_deref().unwrap_or("auto");
            body["tool_choice"] = serde_json::json!({ "type": tc });
        }
    }

    let log_prefix = request
        .log_label
        .as_deref()
        .unwrap_or("thread_proxy");
    eprintln!("[{}] outgoing body tool_choice={:?} tools_len={}", log_prefix, body.get("tool_choice"), body.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0));
    // Full prompt (system + messages) sent to Claude — entire request body for debugging
    if let Ok(pretty) = serde_json::to_string_pretty(&body) {
        eprintln!("[{}] full request body (entire prompt):\n{}", log_prefix, pretty);
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("content-type", "application/json")
        .header("x-api-key", request.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "prompt-caching-2024-07-31")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let retry_after_hdr = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body_res = response.text().await.map_err(|e| e.to_string())?;
    // Truncate at 800 bytes on a char boundary to avoid panicking on multi-byte UTF-8 (e.g. '—').
    let max_byte = body_res.len().min(800);
    let end = body_res
        .char_indices()
        .find(|&(i, _)| i >= max_byte)
        .map(|(i, _)| i)
        .unwrap_or(body_res.len());
    eprintln!("[{}] response status={} body={}", log_prefix, status, &body_res[..end]);
    if !status.is_success() {
        let retry_suffix = retry_after_hdr
            .as_ref()
            .map(|s| format!(" retry_after={}", s))
            .unwrap_or_default();
        let err_msg = format!(
            "Anthropic request failed ({}): {}{}",
            status, body_res, retry_suffix
        );
        return Err(err_msg);
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body_res).map_err(|e| e.to_string())?;
    eprintln!("[{}] stop_reason={:?} content_blocks={}", log_prefix, parsed.get("stop_reason"), parsed.get("content").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0));
    let content_blocks = parsed
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let answer = content_blocks
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<&str>>()
        .join("\n");

    let tool_calls: Vec<serde_json::Value> = content_blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .map(|b| {
            serde_json::json!({
                "name": b.get("name"),
                "id": b.get("id"),
                "input": b.get("input"),
            })
        })
        .collect();

    let usage = parsed.get("usage").and_then(|u| u.as_object()).map(|u| ClaudeUsage {
        cache_creation_input_tokens: u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64()),
        cache_read_input_tokens: u.get("cache_read_input_tokens").and_then(|v| v.as_u64()),
        input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()),
        output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()),
    });

    Ok(ClaudeThreadProxyResponse {
        answer,
        tool_calls,
        raw_content: content_blocks,
        model,
        usage,
    })
}

/// Called by frontend after compaction on close; actually closes the window.
#[tauri::command]
fn allow_window_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_file_base64,
            ask_claude_proxy,
            ask_claude_simple_proxy,
            ask_claude_thread_proxy,
            allow_window_close,
            db_get_all_books,
            db_get_book,
            db_upsert_book,
            db_delete_book,
            db_get_highlights,
            db_upsert_highlight,
            db_delete_highlight,
            db_get_threads,
            db_create_thread,
            db_update_thread_title,
            db_archive_thread,
            db_delete_thread,
            db_clear_all_threads,
            db_get_thread_messages,
            db_save_thread_message,
            db_attach_highlight_to_thread,
            db_get_highlights_for_thread,
            db_get_standalone_highlights,
            db_get_bookmarks,
            db_upsert_bookmark,
            db_delete_bookmark,
            db_update_reading_progress,
            save_cover_image,
            db_get_section_summaries,
            db_upsert_section_summary,
            db_delete_all_section_summaries,
            db_reset_all_book_scan_data,
            db_get_book_scan_status,
            db_set_book_scan_status,
            db_get_book_summary,
            db_set_book_summary,
            db_set_book_structure_type,
            memory_ensure_dirs,
            memory_list_books,
            memory_read_book,
            memory_write_book,
            memory_read_reader,
            memory_write_reader,
        ])
        .setup(|app| {
            cleanup_legacy_progress_file();
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let marginalia_dir = app_data.join("marginalia");
            let db_path = marginalia_dir.join("marginalia.db");
            init_db(&db_path)?;
            app.manage(DbState { db_path });

            let memory_path = marginalia_dir.join("memory");
            std::fs::create_dir_all(&memory_path).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(memory_path.join("books")).map_err(|e| e.to_string())?;
            app.manage(MemoryState {
                base_path: memory_path,
            });

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("marginalia-prepare-close", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Marginalia");
}
