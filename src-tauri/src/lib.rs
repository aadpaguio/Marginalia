use std::path::Path;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Read file at path and return contents as base64 (for EPUB bytes).
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    if !path.is_file() {
        return Err("Path is not a file".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(&bytes))
}

struct DbState {
    db_path: PathBuf,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbNoteInput {
    id: String,
    book_id: String,
    cfi: String,
    selected_text: Option<String>,
    text: Option<String>,
    style: Option<String>,
    color: Option<String>,
    note: String,
    note_kind: Option<String>,
    ai_conversation: Option<String>,
    chapter_label: Option<String>,
    chapter_href: Option<String>,
    page_label: Option<String>,
    page_href: Option<String>,
    page_current: Option<i64>,
    page_total: Option<i64>,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbNote {
    id: String,
    book_id: String,
    cfi: String,
    selected_text: Option<String>,
    text: Option<String>,
    style: Option<String>,
    color: Option<String>,
    note: String,
    note_kind: String,
    ai_conversation: Option<String>,
    chapter_label: Option<String>,
    chapter_href: Option<String>,
    page_label: Option<String>,
    page_href: Option<String>,
    page_current: Option<i64>,
    page_total: Option<i64>,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
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

        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          cfi TEXT NOT NULL,
          selected_text TEXT,
          text TEXT,
          style TEXT,
          color TEXT,
          note TEXT NOT NULL,
          note_kind TEXT NOT NULL DEFAULT 'highlight',
          ai_conversation TEXT,
          chapter_label TEXT,
          chapter_href TEXT,
          page_label TEXT,
          page_href TEXT,
          page_current INTEGER,
          page_total INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes(book_id);
        CREATE INDEX IF NOT EXISTS idx_notes_book_cfi ON notes(book_id, cfi);

        CREATE TABLE IF NOT EXISTS bookmarks (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          cfi TEXT NOT NULL,
          chapter_label TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON bookmarks(book_id);
        "#,
    )
    .map_err(|e| e.to_string())?;
    ensure_note_kind_column(&conn)?;
    Ok(())
}

fn ensure_note_kind_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(notes)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    if !columns.iter().any(|c| c == "note_kind") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'highlight'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "UPDATE notes
         SET note_kind = CASE
           WHEN ai_conversation IS NOT NULL AND trim(ai_conversation) <> '' THEN 'ai_note'
           ELSE 'highlight'
         END
         WHERE note_kind IS NULL OR trim(note_kind) = ''",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn db_get_all_books(state: State<DbState>) -> Result<Vec<DbBook>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, author, file_path, cover_path, last_read_cfi, progress_fraction, added_at, last_opened_at
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
        "SELECT id, title, author, file_path, cover_path, last_read_cfi, progress_fraction, added_at, last_opened_at
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
fn db_get_notes(state: State<DbState>, book_id: String) -> Result<Vec<DbNote>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, cfi, selected_text, text, style, color, note, ai_conversation,
                    note_kind,
                    chapter_label, chapter_href, page_label, page_href, page_current, page_total,
                    created_at, updated_at, deleted_at
             FROM notes
             WHERE book_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(DbNote {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                selected_text: row.get(3)?,
                text: row.get(4)?,
                style: row.get(5)?,
                color: row.get(6)?,
                note: row.get(7)?,
                ai_conversation: row.get(8)?,
                note_kind: row.get(9)?,
                chapter_label: row.get(10)?,
                chapter_href: row.get(11)?,
                page_label: row.get(12)?,
                page_href: row.get(13)?,
                page_current: row.get(14)?,
                page_total: row.get(15)?,
                created_at: row.get(16)?,
                updated_at: row.get(17)?,
                deleted_at: row.get(18)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_note(state: State<DbState>, note: DbNoteInput) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        r#"
        INSERT INTO notes (
          id, book_id, cfi, selected_text, text, style, color, note, note_kind, ai_conversation,
          chapter_label, chapter_href, page_label, page_href, page_current, page_total,
          created_at, updated_at, deleted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
        ON CONFLICT(id) DO UPDATE SET
          book_id = excluded.book_id,
          cfi = excluded.cfi,
          selected_text = excluded.selected_text,
          text = excluded.text,
          style = excluded.style,
          color = excluded.color,
          note = excluded.note,
          note_kind = excluded.note_kind,
          ai_conversation = excluded.ai_conversation,
          chapter_label = excluded.chapter_label,
          chapter_href = excluded.chapter_href,
          page_label = excluded.page_label,
          page_href = excluded.page_href,
          page_current = excluded.page_current,
          page_total = excluded.page_total,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
        "#,
        params![
            note.id,
            note.book_id,
            note.cfi,
            note.selected_text,
            note.text,
            note.style,
            note.color,
            note.note,
            note.note_kind.unwrap_or_else(|| {
                if note
                    .ai_conversation
                    .as_ref()
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
                {
                    "ai_note".to_string()
                } else {
                    "highlight".to_string()
                }
            }),
            note.ai_conversation,
            note.chapter_label,
            note.chapter_href,
            note.page_label,
            note.page_href,
            note.page_current,
            note.page_total,
            note.created_at,
            note.updated_at,
            note.deleted_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_delete_note(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeProxyRequest {
    api_key: String,
    model: String,
    system_prompt: String,
    surrounding_context: String,
    selected_text: String,
    user_message: String,
    conversation_history: Option<Vec<ClaudeHistoryMessage>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHistoryMessage {
    role: String,
    content: String,
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

/// Proxy Claude requests through Rust to avoid WebView network/CORS issues.
#[tauri::command]
async fn ask_claude_proxy(request: ClaudeProxyRequest) -> Result<ClaudeProxyResponse, String> {
    let model = request.model.clone();
    let mut messages = vec![serde_json::json!({
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": format!("Context from the book:\n\n{}", request.surrounding_context),
                "cache_control": { "type": "ephemeral" }
            }
        ]
    })];

    if let Some(history) = request.conversation_history {
        for message in history {
            if (message.role != "user" && message.role != "assistant") || message.content.trim().is_empty() {
                continue;
            }
            messages.push(serde_json::json!({
                "role": message.role,
                "content": [
                    {
                        "type": "text",
                        "text": message.content
                    }
                ]
            }));
        }
    }

    messages.push(serde_json::json!({
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": format!(
                    "Selected passage:\n\"{}\"\n\n{}",
                    request.selected_text, request.user_message
                )
            }
        ]
    }));

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("content-type", "application/json")
        .header("x-api-key", request.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "prompt-caching-2024-07-31")
        .json(&serde_json::json!({
            "model": model.clone(),
            "max_tokens": 900,
            "system": [
                {
                    "type": "text",
                    "text": request.system_prompt,
                    "cache_control": { "type": "ephemeral" }
                }
            ],
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_file_base64,
            ask_claude_proxy,
            db_get_all_books,
            db_get_book,
            db_upsert_book,
            db_delete_book,
            db_get_notes,
            db_upsert_note,
            db_delete_note,
            db_get_bookmarks,
            db_upsert_bookmark,
            db_delete_bookmark,
            db_update_reading_progress,
            save_cover_image
        ])
        .setup(|app| {
            cleanup_legacy_progress_file();
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let db_path = app_data.join("marginalia").join("marginalia.db");
            init_db(&db_path)?;
            app.manage(DbState { db_path });

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Marginalia");
}
