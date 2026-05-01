# Marginalia

<p align="center">
  <img src="pngs/Marginalia%20Logo_1.png" alt="Marginalia logo" width="180" />
</p>

Marginalia is a local-first EPUB reader with an AI partner built into the act of reading.  
It is designed for close reading, not speed-reading: the model starts with the selected passage, then fetches more context only when needed.

Built with Tauri v2 (`Rust + React + TypeScript`) and Anthropic's Claude API under a bring-your-own-key setup.

## Start Here

### Download the latest pre-release (recommended)

Use the published pre-release DMG (instead of building locally):

1. Open [Marginalia v0.1.0-alpha pre-release](https://github.com/aadpaguio/Marginalia/releases/tag/v0.1.0-alpha)
2. Download the `.dmg` from **Assets**
3. Drag `Marginalia.app` into `Applications`
4. Launch and add your Anthropic API key in **Settings**

### Quick links for evaluation results

If you only need benchmark outputs, start in `eval/reports/`:

- Frankenstein: `eval/reports/marginalia-eval-frankenstein_1-Frankenstein_Or_The_Modern_Prometheus-20260425-071628_report/`
- Pride and Prejudice: `eval/reports/marginalia-eval-pnp_2-Pride_and_Prejudice-20260418-171651_report/`
- Walden: `eval/reports/marginalia-eval-walden_2-Walden_and_On_The_Duty_Of_Civil_Disobedi-20260418-183407_report/`

In each folder, open `report_bundle.json` for the top-level summary and `per_question.csv` for per-prompt detail.

## Product At A Glance

- **Reading-first:** the book is the primary interface, and AI is there when invited.
- **Local-first architecture:** EPUB parsing, indexing, thread history, and memory storage happen on your machine.
- **Grounded retrieval:** the model does not receive the full book by default; it asks for extra context via explicit tool calls.
- **Auditable behavior:** tool use and context manifests are logged so retrieval decisions can be inspected.
- **No server backend:** this desktop app runs locally and calls Anthropic directly.

## Screenshots

### Library

![Marginalia library view](pngs/library_screen.png)

### Threads Panel

![Marginalia threads panel](pngs/threads_panel.png)

### Memory Panel

![Marginalia memory panel](pngs/memory_panel.png)

## Architecture Overview

Think of Marginalia as four pieces working together:

1. **Reader (EPUB UI):** renders the book and captures selections/highlights.
  Implementation anchors: `src/app/reader/components/FoliateViewer.tsx` (L386-L415).
2. **Conversation Threads:** each reading discussion is saved as a thread tied to a passage or book context.
  Implementation anchors: `src-tauri/src/lib.rs` thread schema in `threads`, `thread_highlights`, `thread_messages` (L480-L509).
3. **Retrieval Layer (Smart Scan + tools):** gives the model a way to fetch only the extra context it needs.
  Implementation anchors: `src/services/claude.ts` tool definitions `get_context`, `get_section_summary`, `get_section_text` (L728-L788), and Smart Scan storage `section_summaries` in `src-tauri/src/lib.rs` (L511-L530).
4. **Memory Layer:** stores durable reader facts and patterns across sessions.
  Implementation anchors: `src-tauri/src/lib.rs` tables `memory_items`, `memory_anchors`, `memory_vecs` (L532-L566).

In practice: you highlight a passage, ask a question, and Claude answers from that passage first.  
If needed, it can call tools to fetch nearby text, section summaries, or section text.

## What "Threads" Mean

Think of threads as chat: persistent reading conversations linked to your book context.

- A thread starts from a selected passage or a book-level question.
- Messages are stored locally in SQLite, including assistant responses and retrieval events.
- Follow-ups can inherit the active passage context so the conversation remains coherent.
- Threads can be used in evaluation mode to compare retrieval behavior across conditions.

## Tooling Available To The Model

Marginalia's retrieval tools are intentionally explicit:

- `get_context`  
Fetch text near the current passage anchor (`before`, `after`, `around`, `from_section_start`).
- `get_section_summary`  
Fetch Smart Scan summary for a section (`spine_href`).
- `get_section_text`  
Fetch raw text for a section when line-level evidence is needed.
- `request_web_search` / `web_search`  
Optional web lookup path for external context (author background, historical references, criticism), not for replacing book-grounded reading.

This is the core "blind model" posture: retrieval is a visible signal of complexity, not an invisible hidden context dump.

## System Prompt And Intended Behavior

At a high level, the system prompt steers the assistant to:

- be concise, grounded, and conversational;
- privilege the selected passage as the first evidence source;
- avoid unnecessary retrieval;
- avoid broad spoilers or fetching ahead without reason;
- use web search only for genuinely external context.

Desired Marginalia behavior:

- **Close read first** -> answer from the text in front of the reader.
- **Retrieve second** -> use tools only when the question needs broader context.
- **Stay spoiler-aware** -> preserve the reader's progression through the book.
- **Show your work** -> retrieval calls are inspectable in logs/manifests.

## Smart Scan And Memory (How They Fit)

### Smart Scan

Smart Scan is **user-triggered** (not automatic): you run it from the scan button in the reader UI.  
It is **not required** to use Marginalia, but it is highly recommended because it gives retrieval a reliable map of the book.

How it works, briefly:

- it marks the book scan state as in-progress;
- iterates through linear spine sections;
- extracts section text and generates structured per-section summaries;
- infers book structure and generates a book-level overview;
- stores summaries/status locally in SQLite for later retrieval tools.

Relevant implementation files:

- UI trigger and user confirmation flow: `src/App.tsx` (see `handleRunSmartScan` and scan button wiring around L1824-L1985).
- Scan pipeline + summarization flow: `src/services/smartScan.ts` (see `runSmartScan` around L271-L439).
- Persistence schema (`section_summaries`, `smart_scan_status`): `src-tauri/src/lib.rs` (around L511-L530 and migration/status fields).

### Memory Architecture

Memory is a structured, local subsystem for cross-session continuity:

- memory items are stored as atomic facts (with type, scope, confidence, usage metadata);
- anchors connect memories to books/passages/threads;
- embeddings support semantic retrieval over memory items;
- prompt injection is filtered and ranked so only relevant memory enters a turn.

Memory exists in production app behavior but is intentionally scoped out of the main benchmark due to annotation/evaluation cost.

## Evaluation Strategy (Current Run)

The current benchmark is run on **3 public-domain books**:

- Frankenstein
- Pride and Prejudice
- Walden

Each book uses a **15-prompt set** across four categories:

- passage-local
- nearby-context
- book-level-thematic
- cross-section

We compare 3 retrieval tiers:

1. **Passage-only** (no retrieval tools)
2. `**get_context` only**
3. **Smart Scan + all tools** (`get_context` + section summary/text tools)

Evaluation is scored with an **LLM-as-judge** rubric (Haiku), using four metrics:

- faithfulness
- chunk relevance
- answer completeness
- claim precision

Judge outputs also include binary failure flags:

- unsupported_claims
- retrieval_problem
- incomplete_response
- imprecise_or_overbroad


## Evaluation Folder Overview (`eval/`)

The `eval/` directory contains both benchmark inputs and generated outputs:

- `eval/questions/` -> source prompt lists (`*.txt`) per book
- `eval/gold/` -> gold annotations (`*.json`) and `schema.json`
- `eval/config/` -> run mapping + source config (`book_sources.json`, `runset_to_book.json`, rubric config)
- `eval/scripts/` -> pipeline scripts (`run_eval_pipeline.sh`, parsing, judging, scoring, reporting)
- `eval/reports/` -> run artifacts and normalized report bundles
- `eval/requirements-eval.txt` -> Python dependencies for evaluation scripts

### Where Results Live For Each Book

For each evaluated book, results appear under `eval/reports/` in two layers:

1. **Run-level files** (raw step outputs):
  - `<run_id>.judge.json`
  - `<run_id>.score.json`
2. **Report directory** (`<run_id>_report/`) with normalized artifacts:
  - `report_bundle.json` (top-level bundled report)
  - `per_book_summary.json`
  - `cross_book_summary.json`
  - `per_question.json`
  - `per_question.csv`

Current runs in this repo:

- **Frankenstein**  
  - Run prefix: `marginalia-eval-frankenstein_1-Frankenstein_Or_The_Modern_Prometheus-20260425-071628`
  - Raw files:
    - `eval/reports/marginalia-eval-frankenstein_1-Frankenstein_Or_The_Modern_Prometheus-20260425-071628.judge.json`
    - `eval/reports/marginalia-eval-frankenstein_1-Frankenstein_Or_The_Modern_Prometheus-20260425-071628.score.json`
  - Report bundle directory:
    - `eval/reports/marginalia-eval-frankenstein_1-Frankenstein_Or_The_Modern_Prometheus-20260425-071628_report/`

- **Pride and Prejudice**  
  - Run prefix: `marginalia-eval-pnp_2-Pride_and_Prejudice-20260418-171651`
  - Raw files:
    - `eval/reports/marginalia-eval-pnp_2-Pride_and_Prejudice-20260418-171651.judge.json`
    - `eval/reports/marginalia-eval-pnp_2-Pride_and_Prejudice-20260418-171651.score.json`
  - Report bundle directory:
    - `eval/reports/marginalia-eval-pnp_2-Pride_and_Prejudice-20260418-171651_report/`

- **Walden**  
  - Run prefix: `marginalia-eval-walden_2-Walden_and_On_The_Duty_Of_Civil_Disobedi-20260418-183407`
  - Raw files:
    - `eval/reports/marginalia-eval-walden_2-Walden_and_On_The_Duty_Of_Civil_Disobedi-20260418-183407.judge.json`
    - `eval/reports/marginalia-eval-walden_2-Walden_and_On_The_Duty_Of_Civil_Disobedi-20260418-183407.score.json`
  - Report bundle directory:
    - `eval/reports/marginalia-eval-walden_2-Walden_and_On_The_Duty_Of_Civil_Disobedi-20260418-183407_report/`

## Platform + Model Constraints

Current practical constraints:

- **macOS-only** for development/testing at this stage.
- **Claude-only** model stack; default chat model is **Haiku**, with **Sonnet** and **Opus** selectable in Settings.  
Adding multi-provider support is possible, but not trivial in this architecture and timeline.

## Running The App (Dev)

### Prerequisites

- Node.js + npm
- Rust toolchain
- Tauri v2 prerequisites for macOS
- Anthropic API key (entered in-app)

### Setup

1. Install dependencies:
  - `npm install`
2. Start the **dev** app (separate bundle id + data dir from installable builds; enables evaluation UI):
  - `npm run tauri:dev`
3. On first launch, paste your Anthropic API key in **Settings** (gear icon). The key is stored locally in the app database under the dev app support path below (not in the web bundle).

### Installable macOS app (pre-release download)

Use the published pre-release instead of building a local DMG:

1. Open the `v0.1.0-alpha` tag release page: [Marginalia v0.1.0-alpha pre-release](https://github.com/aadpaguio/Marginalia/releases/tag/v0.1.0-alpha)
2. In **Assets**, download the `.dmg` file for `v0.1.0-alpha`.
3. Open the DMG and drag `Marginalia.app` to `Applications`.
4. Launch the app and add your Anthropic API key in **Settings**.

Installable releases use bundle id `app.marginalia.reader` and do **not** show benchmark evaluation UI.

### Evaluation / benchmark UI (dev only)

The hybrid evaluation panel is hidden unless `VITE_ENABLE_EVAL=1` is set at frontend build time. The `tauri:dev` script sets this for you.

## Local App Data Location (macOS)

Marginalia stores local state under Tauri app data directories.

**Production / installable app** (`identifier` `app.marginalia.reader`):

- `~/Library/Application Support/app.marginalia.reader/marginalia/`
- Database: `~/Library/Application Support/app.marginalia.reader/marginalia/marginalia.db`

**Dev** (`npm run tauri:dev`, `identifier` `app.marginalia.reader.dev`):

- `~/Library/Application Support/app.marginalia.reader.dev/marginalia/`
- Database: `~/Library/Application Support/app.marginalia.reader.dev/marginalia/marginalia.db`

App settings (API key + preferred chat model) live in the SQLite `app_meta` table in that same database.

## Uninstall / remove data (macOS)

1. **Quit Marginalia** (Cmd+Q, or Force Quit if needed).
2. **Remove the app from Applications** (optional but usual “uninstall”):
  - Installable build: delete `**/Applications/Marginalia.app`**
  - Dev build: delete `**/Applications/Marginalia Dev.app**` (only if you copied it there; dev often runs from the build output without installing)
3. **Delete local data** (library, reading progress, threads, Smart Scan summaries, saved API key in `app_meta`, etc.):
  - **Production / reviewer install** — remove the whole folder:
    - `~/Library/Application Support/app.marginalia.reader/`
  - **Dev** (`npm run tauri:dev`) — remove:
    - `~/Library/Application Support/app.marginalia.reader.dev/`
   In Finder: **Go → Go to Folder…** (Shift+Cmd+G), paste the path above, then move the folder to the Trash.
4. **Empty Trash** if you want the space back immediately.

Nothing else is required for a normal wipe; there is no separate system-wide “Marginalia service.” If you only delete the `.app` but keep the Application Support folder, your data remains and will reappear if you install Marginalia again.

## Repository Notes

- `src/` -> React/TypeScript UI and orchestration
- `src-tauri/` -> Rust commands, DB schema, tool proxying, local persistence
- `eval/` -> evaluation inputs (`questions/`, `gold/`, `config/`) and outputs (`reports/`)
- `pngs/` -> README and product screenshot assets