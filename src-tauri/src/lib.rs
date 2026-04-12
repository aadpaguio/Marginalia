use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
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

struct EmbeddingState {
    model: Mutex<Option<TextEmbedding>>,
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
    annotation: Option<String>,
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
    flushed_at: Option<i64>,
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
    /// JSON-serialized array of web search citations (optional).
    web_citations: Option<String>,
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
    /// JSON-serialized array of web search citations (nullable).
    web_citations: Option<String>,
}

// Phase 33: context manifest (one per completed thread turn)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextManifestToolCallRow {
    tool: String,
    round: i64,
    input_summary: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextManifest {
    id: String,
    thread_id: String,
    book_id: String,
    created_at: i64,
    turn_mode: String,
    active_anchor_present: bool,
    active_anchor_source: Option<String>,
    active_anchor_cfi: Option<String>,
    active_anchor_chapter: Option<String>,
    system_prompt_chars: i64,
    reader_profile_included: bool,
    reader_profile_chars: Option<i64>,
    book_memory_included: bool,
    book_memory_chars: Option<i64>,
    book_overview_included: bool,
    highlights_count: i64,
    highlights_cfis: Vec<String>,
    history_message_count: i64,
    memory_items_count: i64,
    estimated_input_tokens: Option<i64>,
    tools_available: Vec<String>,
    smart_scan_status: Option<String>,
    tool_calls_made: Option<Vec<ContextManifestToolCallRow>>,
    final_answer_chars: Option<i64>,
}

// Hybrid evaluation mode (benchmark sets / runs / export)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalSetRow {
    id: String,
    name: String,
    description: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalQuestionRow {
    id: String,
    set_id: String,
    book_id: String,
    sort_order: i64,
    prompt: String,
    category: Option<String>,
    expected_min_context: Option<String>,
    spoiler_label: Option<String>,
    anchor_cfi: Option<String>,
    anchor_text: Option<String>,
    chapter_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalQuestionImportRow {
    prompt: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    expected_min_context: Option<String>,
    #[serde(default)]
    spoiler_label: Option<String>,
    #[serde(default)]
    anchor_cfi: Option<String>,
    #[serde(default)]
    anchor_text: Option<String>,
    #[serde(default)]
    chapter_label: Option<String>,
    #[serde(default)]
    sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalCreateRunInput {
    id: String,
    question_id: String,
    condition: String,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalCompleteRunInput {
    id: String,
    manifest_id: Option<String>,
    status: String,
    error_message: Option<String>,
    answer_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalCreateSetPayload {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalAddQuestionsPayload {
    set_id: String,
    book_id: String,
    json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalSetIdPayload {
    set_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalQuestionIdPayload {
    question_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalExportFilterPayload {
    #[serde(default)]
    book_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalSaveExportPayload {
    path: String,
    contents: String,
}

// Phase 30: structured memory items + anchors
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryItemInput {
    id: Option<String>,
    content: String,
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    usage_mode: Option<String>,
    confidence: Option<f64>,
    observation_count: Option<i64>,
    source: Option<String>,
    created_at: Option<i64>,
    last_reinforced_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryAnchorInput {
    id: Option<String>,
    memory_id: Option<String>,
    book_id: Option<String>,
    highlight_id: Option<String>,
    thread_id: Option<String>,
    cfi: Option<String>,
    passage_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryAnchorOut {
    id: String,
    memory_id: String,
    book_id: Option<String>,
    highlight_id: Option<String>,
    thread_id: Option<String>,
    cfi: Option<String>,
    passage_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryItemWithAnchors {
    id: String,
    content: String,
    #[serde(rename = "type")]
    type_: String,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage_mode: Option<String>,
    confidence: f64,
    observation_count: i64,
    source: String,
    created_at: i64,
    last_reinforced_at: i64,
    anchors: Vec<MemoryAnchorOut>,
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
          clean_exchange TEXT,
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

        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          observation_count INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT 'compaction',
          created_at INTEGER NOT NULL,
          last_reinforced_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_anchors (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          book_id TEXT,
          highlight_id TEXT,
          thread_id TEXT,
          cfi TEXT,
          passage_text TEXT,
          FOREIGN KEY(memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
          FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE SET NULL,
          FOREIGN KEY(highlight_id) REFERENCES highlights(id) ON DELETE SET NULL,
          FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_anchors_book ON memory_anchors(book_id);
        CREATE INDEX IF NOT EXISTS idx_memory_anchors_memory ON memory_anchors(memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type);

        CREATE TABLE IF NOT EXISTS memory_vecs (
          memory_rowid INTEGER PRIMARY KEY,
          embedding_json TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS context_manifests (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          turn_mode TEXT NOT NULL,
          active_anchor_present INTEGER NOT NULL CHECK(active_anchor_present IN (0,1)),
          active_anchor_source TEXT,
          active_anchor_cfi TEXT,
          active_anchor_chapter TEXT,
          system_prompt_chars INTEGER NOT NULL,
          reader_profile_included INTEGER NOT NULL CHECK(reader_profile_included IN (0,1)),
          reader_profile_chars INTEGER,
          book_memory_included INTEGER NOT NULL CHECK(book_memory_included IN (0,1)),
          book_memory_chars INTEGER,
          book_overview_included INTEGER NOT NULL CHECK(book_overview_included IN (0,1)),
          highlights_count INTEGER NOT NULL,
          highlights_cfis TEXT,
          history_message_count INTEGER NOT NULL,
          memory_items_count INTEGER NOT NULL DEFAULT 0,
          estimated_input_tokens INTEGER,
          tools_available TEXT NOT NULL,
          smart_scan_status TEXT,
          tool_calls_made TEXT,
          final_answer_chars INTEGER,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
          FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_context_manifests_thread_created
          ON context_manifests(thread_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS eval_sets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS eval_questions (
          id TEXT PRIMARY KEY,
          set_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          prompt TEXT NOT NULL,
          category TEXT,
          expected_min_context TEXT,
          spoiler_label TEXT,
          anchor_cfi TEXT,
          anchor_text TEXT,
          chapter_label TEXT,
          FOREIGN KEY (set_id) REFERENCES eval_sets(id) ON DELETE CASCADE,
          FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_eval_questions_set_order
          ON eval_questions(set_id, sort_order);

        CREATE TABLE IF NOT EXISTS eval_runs (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL,
          condition TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          manifest_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT,
          answer_text TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY (question_id) REFERENCES eval_questions(id) ON DELETE CASCADE,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_eval_runs_question ON eval_runs(question_id);
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
    let _ = conn.execute("ALTER TABLE thread_messages ADD COLUMN web_citations TEXT", ());

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

    // Migration: add annotation to highlights (Phase 29)
    let _ = conn.execute("ALTER TABLE highlights ADD COLUMN annotation TEXT", ());

    // Migration: mid-thread memory flush idempotency (Phase 30)
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN flushed_at INTEGER", ());
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN clean_exchange TEXT", ());

    // Migration: memory item scope + usage metadata (structured prompt injection)
    let _ = conn.execute("ALTER TABLE memory_items ADD COLUMN scope TEXT", ());
    let _ = conn.execute("ALTER TABLE memory_items ADD COLUMN usage_mode TEXT", ());
    backfill_memory_item_scope(&conn)?;

    Ok(())
}

fn normalize_memory_scope(s: &str) -> Option<String> {
    match s.trim() {
        "global" | "book" | "passage" => Some(s.trim().to_string()),
        _ => None,
    }
}

fn derive_memory_scope_from_anchors_json(anchors: &[serde_json::Value]) -> String {
    let has_passage = anchors.iter().any(|a| {
        let book = a
            .get("bookId")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !book {
            return false;
        }
        let cfi = a
            .get("cfi")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let passage_text = a
            .get("passageText")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        cfi || passage_text
    });
    if has_passage {
        return "passage".to_string();
    }
    let has_book = anchors.iter().any(|a| {
        a.get("bookId")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    });
    if has_book {
        "book".to_string()
    } else {
        "global".to_string()
    }
}

/// Backfill scope for legacy rows: passage when anchor ties to book + CFI or passage text, else book when book_id only, else global.
fn backfill_memory_item_scope(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE memory_items SET scope = 'passage'
         WHERE (scope IS NULL OR scope = '')
           AND id IN (
             SELECT memory_id FROM memory_anchors
             WHERE book_id IS NOT NULL AND TRIM(book_id) != ''
               AND (
                 (cfi IS NOT NULL AND TRIM(cfi) != '')
                 OR (passage_text IS NOT NULL AND TRIM(passage_text) != '')
               )
           )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memory_items SET scope = 'book'
         WHERE (scope IS NULL OR scope = '')
           AND id IN (
             SELECT memory_id FROM memory_anchors
             WHERE book_id IS NOT NULL AND TRIM(book_id) != ''
           )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memory_items SET scope = 'global' WHERE scope IS NULL OR scope = ''",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Upgrade book → passage when anchors carry CFI or passage text (fixes DBs migrated before passage backfill).
    conn.execute(
        "UPDATE memory_items SET scope = 'passage'
         WHERE scope = 'book'
           AND id IN (
             SELECT memory_id FROM memory_anchors
             WHERE book_id IS NOT NULL AND TRIM(book_id) != ''
               AND (
                 (cfi IS NOT NULL AND TRIM(cfi) != '')
                 OR (passage_text IS NOT NULL AND TRIM(passage_text) != '')
               )
           )",
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
            "SELECT id, book_id, cfi, selected_text, color, chapter_label, chapter_href, created_at, annotation
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
                annotation: row.get(8)?,
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
fn db_update_highlight_annotation(
    state: State<DbState>,
    id: String,
    annotation: Option<String>,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE highlights SET annotation = ?1 WHERE id = ?2",
        params![annotation, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_threads(state: State<DbState>, book_id: String) -> Result<Vec<DbThread>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, title, created_at, updated_at, archived, flushed_at
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
                flushed_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_mark_thread_flushed(state: State<DbState>, id: String, flushed_at: i64) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("UPDATE threads SET flushed_at = ?1 WHERE id = ?2", params![flushed_at, id])
        .map_err(|e| e.to_string())?;
    Ok(())
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
fn db_set_thread_clean_exchange(
    state: State<DbState>,
    id: String,
    clean_exchange: String,
) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute(
        "UPDATE threads SET clean_exchange = ?1, updated_at = ?2 WHERE id = ?3",
        params![clean_exchange, chrono_like_now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_increment_archive_counter(state: State<DbState>) -> Result<i64, String> {
    let conn = open_db(&state)?;
    let current = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'threads_archived_count'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let next = current + 1;
    conn.execute(
        r#"
        INSERT INTO app_meta (key, value) VALUES ('threads_archived_count', ?1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![next.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
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
            "SELECT id, thread_id, role, content, created_at, excerpt_text, excerpt_cfi, excerpt_chapter, excerpt_color, excerpt_page, web_citations
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
                web_citations: row.get(10)?,
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
        INSERT INTO thread_messages (id, thread_id, role, content, created_at, excerpt_text, excerpt_cfi, excerpt_chapter, excerpt_color, excerpt_page, web_citations)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
            message.web_citations,
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
fn db_save_manifest(state: State<DbState>, manifest: ContextManifest) -> Result<(), String> {
    let conn = open_db(&state)?;
    let tools_available_json =
        serde_json::to_string(&manifest.tools_available).map_err(|e| e.to_string())?;
    let highlights_cfis_json =
        serde_json::to_string(&manifest.highlights_cfis).map_err(|e| e.to_string())?;
    let tool_calls_made_json = manifest
        .tool_calls_made
        .as_ref()
        .map(|v| serde_json::to_string(v).map_err(|e| e.to_string()))
        .transpose()?;
    conn.execute(
        r#"
        INSERT INTO context_manifests (
          id, thread_id, book_id, created_at,
          turn_mode, active_anchor_present, active_anchor_source, active_anchor_cfi, active_anchor_chapter,
          system_prompt_chars, reader_profile_included, reader_profile_chars,
          book_memory_included, book_memory_chars, book_overview_included,
          highlights_count, highlights_cfis, history_message_count, memory_items_count, estimated_input_tokens,
          tools_available, smart_scan_status, tool_calls_made, final_answer_chars
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
        )
        "#,
        params![
            manifest.id,
            manifest.thread_id,
            manifest.book_id,
            manifest.created_at,
            manifest.turn_mode,
            if manifest.active_anchor_present { 1i64 } else { 0i64 },
            manifest.active_anchor_source,
            manifest.active_anchor_cfi,
            manifest.active_anchor_chapter,
            manifest.system_prompt_chars,
            if manifest.reader_profile_included { 1i64 } else { 0i64 },
            manifest.reader_profile_chars,
            if manifest.book_memory_included { 1i64 } else { 0i64 },
            manifest.book_memory_chars,
            if manifest.book_overview_included { 1i64 } else { 0i64 },
            manifest.highlights_count,
            highlights_cfis_json,
            manifest.history_message_count,
            manifest.memory_items_count,
            manifest.estimated_input_tokens,
            tools_available_json,
            manifest.smart_scan_status,
            tool_calls_made_json,
            manifest.final_answer_chars,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_get_manifests_for_thread(
    state: State<DbState>,
    thread_id: String,
) -> Result<Vec<ContextManifest>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, thread_id, book_id, created_at, turn_mode, active_anchor_present,
             active_anchor_source, active_anchor_cfi, active_anchor_chapter,
             system_prompt_chars, reader_profile_included, reader_profile_chars,
             book_memory_included, book_memory_chars, book_overview_included,
             highlights_count, highlights_cfis, history_message_count, memory_items_count, estimated_input_tokens,
             tools_available, smart_scan_status, tool_calls_made, final_answer_chars
             FROM context_manifests WHERE thread_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![thread_id], |row| {
            let tools_available: String = row.get(20)?;
            let highlights_cfis: String = row.get(16)?;
            let tool_calls_made: Option<String> = row.get(22)?;
            let tools_available: Vec<String> =
                serde_json::from_str(&tools_available).unwrap_or_default();
            let highlights_cfis: Vec<String> =
                serde_json::from_str(&highlights_cfis).unwrap_or_default();
            let tool_calls_made: Option<Vec<ContextManifestToolCallRow>> = tool_calls_made
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok());
            Ok(ContextManifest {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                book_id: row.get(2)?,
                created_at: row.get(3)?,
                turn_mode: row.get(4)?,
                active_anchor_present: row.get::<_, i64>(5)? != 0,
                active_anchor_source: row.get(6)?,
                active_anchor_cfi: row.get(7)?,
                active_anchor_chapter: row.get(8)?,
                system_prompt_chars: row.get(9)?,
                reader_profile_included: row.get::<_, i64>(10)? != 0,
                reader_profile_chars: row.get(11)?,
                book_memory_included: row.get::<_, i64>(12)? != 0,
                book_memory_chars: row.get(13)?,
                book_overview_included: row.get::<_, i64>(14)? != 0,
                highlights_count: row.get(15)?,
                highlights_cfis,
                history_message_count: row.get(17)?,
                memory_items_count: row.get(18)?,
                estimated_input_tokens: row.get(19)?,
                tools_available,
                smart_scan_status: row.get(21)?,
                tool_calls_made,
                final_answer_chars: row.get(23)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_latest_manifest_for_thread(
    state: State<DbState>,
    thread_id: String,
) -> Result<Option<ContextManifest>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, thread_id, book_id, created_at, turn_mode, active_anchor_present,
             active_anchor_source, active_anchor_cfi, active_anchor_chapter,
             system_prompt_chars, reader_profile_included, reader_profile_chars,
             book_memory_included, book_memory_chars, book_overview_included,
             highlights_count, highlights_cfis, history_message_count, memory_items_count, estimated_input_tokens,
             tools_available, smart_scan_status, tool_calls_made, final_answer_chars
             FROM context_manifests WHERE thread_id = ?1 ORDER BY created_at DESC LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let opt = stmt
        .query_row(params![thread_id], |row| {
            let tools_available: String = row.get(20)?;
            let highlights_cfis: String = row.get(16)?;
            let tool_calls_made: Option<String> = row.get(22)?;
            let tools_available: Vec<String> =
                serde_json::from_str(&tools_available).unwrap_or_default();
            let highlights_cfis: Vec<String> =
                serde_json::from_str(&highlights_cfis).unwrap_or_default();
            let tool_calls_made: Option<Vec<ContextManifestToolCallRow>> = tool_calls_made
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok());
            Ok(ContextManifest {
                id: row.get(0)?,
                thread_id: row.get(1)?,
                book_id: row.get(2)?,
                created_at: row.get(3)?,
                turn_mode: row.get(4)?,
                active_anchor_present: row.get::<_, i64>(5)? != 0,
                active_anchor_source: row.get(6)?,
                active_anchor_cfi: row.get(7)?,
                active_anchor_chapter: row.get(8)?,
                system_prompt_chars: row.get(9)?,
                reader_profile_included: row.get::<_, i64>(10)? != 0,
                reader_profile_chars: row.get(11)?,
                book_memory_included: row.get::<_, i64>(12)? != 0,
                book_memory_chars: row.get(13)?,
                book_overview_included: row.get::<_, i64>(14)? != 0,
                highlights_count: row.get(15)?,
                highlights_cfis,
                history_message_count: row.get(17)?,
                memory_items_count: row.get(18)?,
                estimated_input_tokens: row.get(19)?,
                tools_available,
                smart_scan_status: row.get(21)?,
                tool_calls_made,
                final_answer_chars: row.get(23)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(opt)
}

fn eval_generate_id(prefix: &str) -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{n}")
}

#[tauri::command]
fn eval_create_set(state: State<DbState>, payload: EvalCreateSetPayload) -> Result<EvalSetRow, String> {
    let conn = open_db(&state)?;
    let id = eval_generate_id("evalset");
    let created_at = chrono_like_now();
    conn.execute(
        "INSERT INTO eval_sets (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, payload.name, payload.description, created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(EvalSetRow {
        id,
        name: payload.name,
        description: payload.description,
        created_at,
    })
}

#[tauri::command]
fn eval_list_sets(state: State<DbState>) -> Result<Vec<EvalSetRow>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, created_at FROM eval_sets ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EvalSetRow {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn eval_delete_set(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM eval_sets WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn eval_add_questions_json(
    state: State<DbState>,
    payload: EvalAddQuestionsPayload,
) -> Result<i64, String> {
    let rows: Vec<EvalQuestionImportRow> =
        serde_json::from_str(&payload.json).map_err(|e| format!("Invalid questions JSON: {e}"))?;
    let conn = open_db(&state)?;
    let mut count: i64 = 0;
    let base_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM eval_questions WHERE set_id = ?1",
            params![payload.set_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    for (i, q) in rows.into_iter().enumerate() {
        let qid = eval_generate_id("evalq");
        let ord = q.sort_order.unwrap_or(base_order + i as i64);
        conn.execute(
            r#"INSERT INTO eval_questions (
              id, set_id, book_id, sort_order, prompt, category, expected_min_context,
              spoiler_label, anchor_cfi, anchor_text, chapter_label
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"#,
            params![
                qid,
                payload.set_id,
                payload.book_id,
                ord,
                q.prompt,
                q.category,
                q.expected_min_context,
                q.spoiler_label,
                q.anchor_cfi,
                q.anchor_text,
                q.chapter_label,
            ],
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

#[tauri::command]
fn eval_list_questions(
    state: State<DbState>,
    payload: EvalSetIdPayload,
) -> Result<Vec<EvalQuestionRow>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            r#"SELECT id, set_id, book_id, sort_order, prompt, category, expected_min_context,
               spoiler_label, anchor_cfi, anchor_text, chapter_label
               FROM eval_questions WHERE set_id = ?1 ORDER BY sort_order ASC, id ASC"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![payload.set_id], |row| {
            Ok(EvalQuestionRow {
                id: row.get(0)?,
                set_id: row.get(1)?,
                book_id: row.get(2)?,
                sort_order: row.get(3)?,
                prompt: row.get(4)?,
                category: row.get(5)?,
                expected_min_context: row.get(6)?,
                spoiler_label: row.get(7)?,
                anchor_cfi: row.get(8)?,
                anchor_text: row.get(9)?,
                chapter_label: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn eval_create_run(state: State<DbState>, input: EvalCreateRunInput) -> Result<(), String> {
    let conn = open_db(&state)?;
    let created_at = chrono_like_now();
    conn.execute(
        r#"INSERT INTO eval_runs (id, question_id, condition, thread_id, manifest_id, status, error_message, answer_text, created_at, completed_at)
           VALUES (?1, ?2, ?3, ?4, NULL, 'pending', NULL, NULL, ?5, NULL)"#,
        params![
            input.id,
            input.question_id,
            input.condition,
            input.thread_id,
            created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn eval_complete_run(state: State<DbState>, input: EvalCompleteRunInput) -> Result<(), String> {
    let conn = open_db(&state)?;
    let completed_at = chrono_like_now();
    conn.execute(
        r#"UPDATE eval_runs SET manifest_id = ?1, status = ?2, error_message = ?3, answer_text = ?4, completed_at = ?5
           WHERE id = ?6"#,
        params![
            input.manifest_id,
            input.status,
            input.error_message,
            input.answer_text,
            completed_at,
            input.id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn eval_list_runs_for_question(
    state: State<DbState>,
    payload: EvalQuestionIdPayload,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            r#"SELECT id, question_id, condition, thread_id, manifest_id, status, error_message, answer_text, created_at, completed_at
               FROM eval_runs WHERE question_id = ?1 ORDER BY created_at DESC"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![payload.question_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "questionId": row.get::<_, String>(1)?,
                "condition": row.get::<_, String>(2)?,
                "threadId": row.get::<_, String>(3)?,
                "manifestId": row.get::<_, Option<String>>(4)?,
                "status": row.get::<_, String>(5)?,
                "errorMessage": row.get::<_, Option<String>>(6)?,
                "answerText": row.get::<_, Option<String>>(7)?,
                "createdAt": row.get::<_, i64>(8)?,
                "completedAt": row.get::<_, Option<i64>>(9)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn latest_assistant_message(conn: &Connection, thread_id: &str) -> Result<(Option<String>, Option<String>), String> {
    let mut stmt = conn
        .prepare(
            "SELECT content, web_citations FROM thread_messages WHERE thread_id = ?1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![thread_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    if let Some(r) = rows.next() {
        let (c, w) = r.map_err(|e| e.to_string())?;
        return Ok((Some(c), w));
    }
    Ok((None, None))
}

#[tauri::command]
fn eval_export_jsonl(
    state: State<DbState>,
    filter: EvalExportFilterPayload,
) -> Result<String, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            r#"SELECT
                 r.id, r.question_id, r.condition, r.thread_id, r.manifest_id, r.status, r.error_message,
                 r.answer_text, r.created_at, r.completed_at,
                 q.set_id, q.book_id, q.prompt, q.category, q.expected_min_context, q.spoiler_label,
                 q.anchor_cfi, q.anchor_text, q.chapter_label,
                 s.name,
                 m.tools_available, m.tool_calls_made, m.smart_scan_status, m.final_answer_chars
               FROM eval_runs r
               JOIN eval_questions q ON q.id = r.question_id
               JOIN eval_sets s ON s.id = q.set_id
               LEFT JOIN context_manifests m ON m.id = r.manifest_id
               WHERE (?1 IS NULL OR q.book_id = ?1)
               ORDER BY r.created_at ASC"#,
        )
        .map_err(|e| e.to_string())?;
    let bid = filter.book_id.as_deref();
    let base_rows: Vec<(String, String, String, String, Option<String>, String, Option<String>, Option<String>, i64, Option<i64>, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String, Option<String>, Option<String>, Option<String>, Option<i64>)> = stmt
        .query_map(params![bid], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                row.get(16)?,
                row.get(17)?,
                row.get(18)?,
                row.get(19)?,
                row.get(20)?,
                row.get(21)?,
                row.get(22)?,
                row.get(23)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut lines: Vec<String> = Vec::new();
    for (
        run_id,
        question_id,
        condition,
        thread_id,
        manifest_id,
        status,
        error_message,
        answer_text,
        created_at,
        completed_at,
        set_id,
        book_id_val,
        prompt,
        category,
        expected_min_context,
        spoiler_label,
        anchor_cfi,
        anchor_text,
        chapter_label,
        set_name,
        tools_available,
        tool_calls_made,
        smart_scan_status,
        final_answer_chars,
    ) in base_rows
    {
        let (assistant_content, assistant_web_citations) =
            latest_assistant_message(&conn, &thread_id).unwrap_or((None, None));
        let v = serde_json::json!({
            "runId": run_id,
            "questionId": question_id,
            "condition": condition,
            "threadId": thread_id,
            "manifestId": manifest_id,
            "status": status,
            "errorMessage": error_message,
            "answerTextStored": answer_text,
            "runCreatedAt": created_at,
            "runCompletedAt": completed_at,
            "setId": set_id,
            "bookId": book_id_val,
            "prompt": prompt,
            "category": category,
            "expectedMinContext": expected_min_context,
            "spoilerLabel": spoiler_label,
            "anchorCfi": anchor_cfi,
            "anchorText": anchor_text,
            "chapterLabel": chapter_label,
            "setName": set_name,
            "manifestToolsAvailable": tools_available,
            "manifestToolCallsMade": tool_calls_made,
            "manifestSmartScanStatus": smart_scan_status,
            "manifestFinalAnswerChars": final_answer_chars,
            "assistantMessageContent": assistant_content,
            "assistantWebCitations": assistant_web_citations,
        });
        lines.push(serde_json::to_string(&v).map_err(|e| e.to_string())?);
    }
    Ok(lines.join("\n"))
}

fn csv_escape(s: &str) -> String {
    if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
        let t = s.replace('"', "\"\"");
        format!("\"{t}\"")
    } else {
        s.to_string()
    }
}

#[tauri::command]
fn eval_export_csv(state: State<DbState>, filter: EvalExportFilterPayload) -> Result<String, String> {
    let conn = open_db(&state)?;
    let headers = [
        "runId",
        "questionId",
        "condition",
        "status",
        "setName",
        "bookId",
        "category",
        "expectedMinContext",
        "spoilerLabel",
        "prompt",
        "anchorCfi",
        "threadId",
        "manifestId",
        "manifestToolsAvailable",
        "manifestToolCallsMade",
        "manifestSmartScanStatus",
        "manifestFinalAnswerChars",
        "errorMessage",
        "answerTextStored",
        "assistantMessageContent",
        "assistantWebCitations",
        "runCreatedAt",
        "runCompletedAt",
    ];
    let mut out = headers.join(",") + "\n";
    let mut stmt = conn
        .prepare(
            r#"SELECT
                 r.id, r.question_id, r.condition, r.status,
                 s.name, q.book_id, q.category, q.expected_min_context, q.spoiler_label,
                 q.prompt, q.anchor_cfi, r.thread_id, r.manifest_id,
                 m.tools_available, m.tool_calls_made, m.smart_scan_status, m.final_answer_chars,
                 r.error_message, r.answer_text, r.created_at, r.completed_at
               FROM eval_runs r
               JOIN eval_questions q ON q.id = r.question_id
               JOIN eval_sets s ON s.id = q.set_id
               LEFT JOIN context_manifests m ON m.id = r.manifest_id
               WHERE (?1 IS NULL OR q.book_id = ?1)
               ORDER BY r.created_at ASC"#,
        )
        .map_err(|e| e.to_string())?;
    let bid = filter.book_id.as_deref();
    type CsvRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        i64,
        Option<i64>,
    );
    let base: Vec<CsvRow> = stmt
        .query_map(params![bid], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                row.get(16)?,
                row.get(17)?,
                row.get(18)?,
                row.get(19)?,
                row.get(20)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for (
        run_id,
        qid,
        cond,
        status,
        set_name,
        bid_val,
        cat,
        emc,
        spoil,
        prompt,
        anchor,
        thread_id,
        mid,
        tools_av,
        tools_made,
        scan,
        fac,
        err,
        ans,
        created,
        completed,
    ) in base
    {
        let (asst, asst_web) = latest_assistant_message(&conn, &thread_id).unwrap_or((None, None));
        let row = vec![
            csv_escape(&run_id),
            csv_escape(&qid),
            csv_escape(&cond),
            csv_escape(&status),
            csv_escape(&set_name),
            csv_escape(&bid_val),
            csv_escape(&cat.unwrap_or_default()),
            csv_escape(&emc.unwrap_or_default()),
            csv_escape(&spoil.unwrap_or_default()),
            csv_escape(&prompt),
            csv_escape(&anchor.unwrap_or_default()),
            csv_escape(&thread_id),
            csv_escape(&mid.unwrap_or_default()),
            csv_escape(&tools_av.unwrap_or_default()),
            csv_escape(&tools_made.unwrap_or_default()),
            csv_escape(&scan.unwrap_or_default()),
            fac.map(|n| n.to_string()).unwrap_or_default(),
            csv_escape(&err.unwrap_or_default()),
            csv_escape(&ans.unwrap_or_default()),
            csv_escape(&asst.unwrap_or_default()),
            csv_escape(&asst_web.unwrap_or_default()),
            created.to_string(),
            completed.map(|n| n.to_string()).unwrap_or_default(),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }
    Ok(out)
}

/// Write eval export bytes (avoids configuring fs plugin scopes for arbitrary save paths).
#[tauri::command]
fn eval_save_export_file(payload: EvalSaveExportPayload) -> Result<(), String> {
    if payload.path.trim().is_empty() {
        return Err("Empty path".to_string());
    }
    std::fs::write(payload.path, payload.contents).map_err(|e| e.to_string())
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
            "SELECT h.id, h.book_id, h.cfi, h.selected_text, h.color, h.chapter_label, h.chapter_href, h.created_at, h.annotation
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
                annotation: row.get(8)?,
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
            "SELECT h.id, h.book_id, h.cfi, h.selected_text, h.color, h.chapter_label, h.chapter_href, h.created_at, h.annotation
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
                annotation: row.get(8)?,
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

fn embed_text(state: &EmbeddingState, text: &str) -> Option<Vec<f32>> {
    let mut guard = state.model.lock().ok()?;
    if guard.is_none() {
        let init = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::BGESmallENV15Q).with_show_download_progress(false),
        )
        .ok()?;
        *guard = Some(init);
    }
    let model = guard.as_mut()?;
    let docs = vec![text];
    let mut out = model.embed(docs, None).ok()?;
    out.pop()
}

fn to_embedding_json(values: &[f32]) -> String {
    let mut out = String::with_capacity(values.len() * 8);
    out.push('[');
    for (idx, v) in values.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        out.push_str(&format!("{:.7}", v));
    }
    out.push(']');
    out
}

fn parse_embedding_json(s: &str) -> Option<Vec<f32>> {
    serde_json::from_str::<Vec<f32>>(s).ok()
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= f32::EPSILON || nb <= f32::EPSILON {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn upsert_memory_embedding(
    embedding_state: &EmbeddingState,
    conn: &Connection,
    memory_id: &str,
    content: &str,
) -> Result<(), String> {
    let embedding = match embed_text(embedding_state, content) {
        Some(v) => v,
        None => return Ok(()),
    };
    let memory_rowid: i64 = conn
        .query_row(
            "SELECT rowid FROM memory_items WHERE id = ?1",
            params![memory_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        r#"
        INSERT INTO memory_vecs (memory_rowid, embedding_json, model, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(memory_rowid) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          model = excluded.model,
          updated_at = excluded.updated_at
        "#,
        params![
            memory_rowid,
            to_embedding_json(&embedding),
            "BGESmallENV15Q",
            chrono_like_now()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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

// Phase 30: structured memory items
#[tauri::command]
fn memory_save_item(
    state: State<DbState>,
    embedding_state: State<EmbeddingState>,
    item: serde_json::Value,
    anchors: Vec<serde_json::Value>,
) -> Result<String, String> {
    let item: MemoryItemInput = serde_json::from_value(item).map_err(|e| e.to_string())?;
    let now = chrono_like_now();
    let id = item
        .id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("mi-{}-{:x}", now, (now as u64).wrapping_add(1) % 0x1000000));
    let source = item.source.unwrap_or_else(|| "compaction".to_string());
    let confidence = if source == "user_explicit" {
        0.9
    } else {
        item.confidence.unwrap_or(0.5)
    };
    let observation_count = item.observation_count.unwrap_or(1);
    let created_at = item.created_at.unwrap_or(now);
    let last_reinforced_at = item.last_reinforced_at.unwrap_or(now);
    let scope_final = item
        .scope
        .as_ref()
        .and_then(|s| normalize_memory_scope(s))
        .unwrap_or_else(|| derive_memory_scope_from_anchors_json(&anchors));
    let usage_mode_out = item
        .usage_mode
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .and_then(|s| {
            if s == "implicit" || s == "callout_ok" {
                Some(s)
            } else {
                None
            }
        });

    let conn = open_db(&state)?;
    conn.execute(
        "INSERT INTO memory_items (id, content, type, confidence, observation_count, source, created_at, last_reinforced_at, scope, usage_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            item.content,
            item.type_,
            confidence,
            observation_count,
            source,
            created_at,
            last_reinforced_at,
            scope_final,
            usage_mode_out,
        ],
    )
    .map_err(|e| e.to_string())?;

    for (idx, a) in anchors.iter().enumerate() {
        let a: MemoryAnchorInput = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
        let anchor_id = a
            .id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("ma-{}-{}", id, idx));
        let memory_id = a.memory_id.as_deref().unwrap_or(&id);
        conn.execute(
            "INSERT INTO memory_anchors (id, memory_id, book_id, highlight_id, thread_id, cfi, passage_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                anchor_id,
                memory_id,
                a.book_id,
                a.highlight_id,
                a.thread_id,
                a.cfi,
                a.passage_text,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    let is_global = anchors.iter().all(|a| {
        a.get("bookId")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
    });
    if is_global {
        let _ = upsert_memory_embedding(&embedding_state, &conn, &id, &item.content);
    }
    Ok(id)
}

#[tauri::command]
fn memory_get_items_for_book(state: State<DbState>, book_id: String) -> Result<Vec<MemoryItemWithAnchors>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id FROM memory_items
             WHERE id IN (SELECT memory_id FROM memory_anchors WHERE book_id = ?1)
             ORDER BY confidence DESC",
        )
        .map_err(|e| e.to_string())?;
    let item_ids: Vec<String> = stmt
        .query_map(params![book_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut out = Vec::with_capacity(item_ids.len());
    for id in item_ids {
        if let Some(item) = get_memory_item_with_anchors(&conn, &id)? {
            out.push(item);
        }
    }
    Ok(out)
}

#[tauri::command]
fn memory_get_items_global(state: State<DbState>) -> Result<Vec<MemoryItemWithAnchors>, String> {
    let conn = open_db(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id FROM memory_items
             WHERE id NOT IN (SELECT memory_id FROM memory_anchors WHERE book_id IS NOT NULL AND book_id != '')
             ORDER BY confidence DESC, observation_count DESC",
        )
        .map_err(|e| e.to_string())?;
    let item_ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut out = Vec::with_capacity(item_ids.len());
    for id in item_ids {
        if let Some(item) = get_memory_item_with_anchors(&conn, &id)? {
            out.push(item);
        }
    }
    Ok(out)
}

#[tauri::command]
fn memory_get_items_global_for_query(
    state: State<DbState>,
    embedding_state: State<EmbeddingState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<MemoryItemWithAnchors>, String> {
    let conn = open_db(&state)?;
    let capped = limit.unwrap_or(5).clamp(1, 10) as usize;
    let query_embedding = match embed_text(&embedding_state, query.trim()) {
        Some(v) => v,
        None => {
            let mut fallback_stmt = conn
                .prepare(
                    "SELECT id FROM memory_items
                     WHERE id NOT IN (SELECT memory_id FROM memory_anchors WHERE book_id IS NOT NULL AND book_id != '')
                     ORDER BY last_reinforced_at DESC, confidence DESC
                     LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let fallback_ids: Vec<String> = fallback_stmt
                .query_map(params![capped as i64], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            drop(fallback_stmt);
            let mut fallback = Vec::new();
            for id in fallback_ids {
                if let Some(item) = get_memory_item_with_anchors(&conn, &id)? {
                    fallback.push(item);
                }
            }
            return Ok(fallback);
        }
    };

    let mut stmt = conn
        .prepare(
            r#"
            SELECT mi.id, mv.embedding_json
            FROM memory_items mi
            JOIN memory_vecs mv ON mv.memory_rowid = mi.rowid
            WHERE mi.id NOT IN (
              SELECT memory_id FROM memory_anchors WHERE book_id IS NOT NULL AND book_id != ''
            )
            "#,
        )
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut ranked: Vec<(String, f32)> = pairs
        .into_iter()
        .filter_map(|(id, emb_json)| {
            let emb = parse_embedding_json(&emb_json)?;
            Some((id, cosine_similarity(&query_embedding, &emb)))
        })
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = Vec::new();
    for (id, _) in ranked.into_iter().take(capped) {
        if let Some(item) = get_memory_item_with_anchors(&conn, &id)? {
            out.push(item);
        }
    }
    if out.is_empty() {
        let mut fallback_stmt = conn
            .prepare(
                "SELECT id FROM memory_items
                 WHERE id NOT IN (SELECT memory_id FROM memory_anchors WHERE book_id IS NOT NULL AND book_id != '')
                 ORDER BY last_reinforced_at DESC, confidence DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let fallback_ids: Vec<String> = fallback_stmt
            .query_map(params![capped as i64], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(fallback_stmt);
        for id in fallback_ids {
            if let Some(item) = get_memory_item_with_anchors(&conn, &id)? {
                out.push(item);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn memory_get_thread_messages(state: State<DbState>, thread_id: String) -> Result<String, String> {
    let conn = open_db(&state)?;
    let clean = conn
        .query_row(
            "SELECT clean_exchange FROM threads WHERE id = ?1",
            params![thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(clean.unwrap_or_default())
}

fn get_memory_item_with_anchors(conn: &Connection, id: &str) -> Result<Option<MemoryItemWithAnchors>, String> {
    let item_row = conn
        .query_row(
            "SELECT id, content, type, confidence, observation_count, source, created_at, last_reinforced_at,
                    COALESCE(NULLIF(TRIM(scope), ''), 'global'), usage_mode
             FROM memory_items WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (
        id_s,
        content,
        type_,
        confidence,
        observation_count,
        source,
        created_at,
        last_reinforced_at,
        scope,
        usage_mode,
    ) = match item_row {
        Some(r) => r,
        None => return Ok(None),
    };

    let mut stmt = conn
        .prepare("SELECT id, memory_id, book_id, highlight_id, thread_id, cfi, passage_text FROM memory_anchors WHERE memory_id = ?1")
        .map_err(|e| e.to_string())?;
    let anchors: Vec<MemoryAnchorOut> = stmt
        .query_map(params![id], |row| {
            Ok(MemoryAnchorOut {
                id: row.get(0)?,
                memory_id: row.get(1)?,
                book_id: row.get(2)?,
                highlight_id: row.get(3)?,
                thread_id: row.get(4)?,
                cfi: row.get(5)?,
                passage_text: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(Some(MemoryItemWithAnchors {
        id: id_s,
        content,
        type_,
        scope,
        usage_mode,
        confidence,
        observation_count,
        source,
        created_at,
        last_reinforced_at,
        anchors,
    }))
}

#[tauri::command]
fn memory_reinforce_item(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    let (current_confidence, observation_count, source): (f64, i64, String) = conn
        .query_row(
            "SELECT confidence, observation_count, source FROM memory_items WHERE id = ?1",
            params![&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let new_count = observation_count + 1;
    let new_confidence = if source == "user_explicit" {
        current_confidence
    } else {
        1.0 - (1.0 - current_confidence) * 0.6_f64
    };
    let now = chrono_like_now();
    conn.execute(
        "UPDATE memory_items SET observation_count = ?1, last_reinforced_at = ?2, confidence = ?3 WHERE id = ?4",
        params![new_count, now, new_confidence, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn memory_run_cross_book_synthesis_stub(state: State<DbState>) -> Result<String, String> {
    let conn = open_db(&state)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_items
             WHERE id NOT IN (SELECT memory_id FROM memory_anchors WHERE book_id IS NOT NULL AND book_id != '')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "TODO: run cross-book synthesis over {} global memory items with Haiku",
        count
    ))
}

#[tauri::command]
fn memory_delete_item(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = open_db(&state)?;
    conn.execute("DELETE FROM memory_items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
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
    stop_reason: Option<String>,
    web_search_requests: Option<u64>,
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
        // Prompt caching beta. `web_search_20250305` is documented as GA (no extra beta header).
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

    let usage_obj = parsed.get("usage").and_then(|u| u.as_object());
    let usage = usage_obj.map(|u| ClaudeUsage {
        cache_creation_input_tokens: u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64()),
        cache_read_input_tokens: u.get("cache_read_input_tokens").and_then(|v| v.as_u64()),
        input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()),
        output_tokens: u.get("output_tokens").and_then(|v| v.as_u64()),
    });

    let stop_reason = parsed
        .get("stop_reason")
        .and_then(|v| v.as_str())
        .map(String::from);

    let web_search_requests = usage_obj
        .and_then(|u| u.get("server_tool_use"))
        .and_then(|s| s.get("web_search_requests"))
        .and_then(|v| v.as_u64());

    Ok(ClaudeThreadProxyResponse {
        answer,
        tool_calls,
        raw_content: content_blocks,
        model,
        usage,
        stop_reason,
        web_search_requests,
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
            db_update_highlight_annotation,
            db_get_threads,
            db_create_thread,
            db_update_thread_title,
            db_archive_thread,
            db_set_thread_clean_exchange,
            db_increment_archive_counter,
            db_mark_thread_flushed,
            db_delete_thread,
            db_clear_all_threads,
            db_get_thread_messages,
            db_save_thread_message,
            db_save_manifest,
            db_get_manifests_for_thread,
            db_get_latest_manifest_for_thread,
            eval_create_set,
            eval_list_sets,
            eval_delete_set,
            eval_add_questions_json,
            eval_list_questions,
            eval_create_run,
            eval_complete_run,
            eval_list_runs_for_question,
            eval_export_jsonl,
            eval_export_csv,
            eval_save_export_file,
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
            memory_save_item,
            memory_get_items_for_book,
            memory_get_items_global,
            memory_get_items_global_for_query,
            memory_get_thread_messages,
            memory_reinforce_item,
            memory_delete_item,
            memory_run_cross_book_synthesis_stub,
        ])
        .setup(|app| {
            cleanup_legacy_progress_file();
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let marginalia_dir = app_data.join("marginalia");
            let db_path = marginalia_dir.join("marginalia.db");
            init_db(&db_path)?;
            app.manage(DbState { db_path });
            app.manage(EmbeddingState {
                model: Mutex::new(None),
            });
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let embedding_state = app_handle.state::<EmbeddingState>();
                if embed_text(&embedding_state, "warmup marginalia memory embeddings").is_some() {
                    eprintln!("[embeddings] warm-up complete");
                } else {
                    eprintln!("[embeddings] warm-up failed; lazy init remains enabled");
                }
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
