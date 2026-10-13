# CLAUDE.md — legacy notebook

Frozen. This folder holds the original browser notebook, kept only because
GitHub Pages still deploys it (`.github/workflows/pages.yml`). Do not add
features here; the active product is the harness described in
[../CLAUDE.md](../CLAUDE.md). Delete this folder once the harness replaces the
site.

## Project Overview

Slate is a client-side graph-based document editor with AI-powered card creation. It uses vanilla ES6+ JavaScript (no framework) with Vite as the build tool. The app runs entirely in the browser — no backend server.

Live demo: www.slate-notebook.com

## Commands

Run from the repository root:

```bash
npm run legacy:dev     # Dev server for legacy/src (auto-opens browser)
npm run legacy:build   # Production build to legacy/dist/ (GitHub Pages)
npm run legacy:test    # Vitest suite in legacy/test/
```

## Architecture

### Data Hierarchy

```
Project → Document[] → Card[]
```

Each Card stores: title, content (rendered markdown HTML), prompt (original text), images (base64), and links (parsed @references). All data serializes to/from JSON for import/export.

### Source Layout (all in `legacy/src/`)

- **Entry point**: `index.html` loads `main_script.js`
- **MainManager** (`main_script.js`) — central orchestrator, holds current project/doc, manages DOM and event handlers
- **Project** (`project.js`) — manages documents, generates graph data, handles JSON import/export
- **Doc** (`doc.js`) — manages cards, tracks summaries, ensures unique card titles
- **Card** (`cards.js`) — renders three-section card UI (header + prompt + response), handles @reference links, image display, move-between-docs
- **ChatManager** (`ai_chat.js`) — prompt handling, image attach/paste, @reference parsing, bibliography construction, triggers summary generation on card add
- **AI agents** (`ai_utils.js`) — OpenAI (GPT-4o-mini, primary) and Gemini wrappers
- **NetworkViz** (`network_viz.js`) — D3.js force-directed graph with collision detection, zoom/pan, two edge types (hierarchy=cyan/thick, reference=red/thin)
- **CodeMirror** (`codemirror_setup.js`) — custom theme, @reference syntax highlighting (cyan), project-wide autocomplete across all documents
- **Modal** (`modal.js`) — custom alert/confirm/select dialogs

### Design System

The **Monad System** lives in `design-tokens/` (git submodule from `range-et/monad_system`). It provides CSS custom properties for colors, typography, and motion.

- `design-tokens/build/monad.css` + `monad.js` are served as public assets via Vite config
- `src/slate_palette.css` bridges legacy color aliases (e.g. `--background`) to Monad tokens (e.g. `--strata-bg`)
- Dark/light mode toggle is built into `monad.js`

### Build Configuration

Vite config (`legacy/vite.config.js`):
- Root: `legacy/src/`
- Public dir: `design-tokens/build/` (monad.css/js served as static assets)
- Output: `legacy/dist/`

### API Key Management

- Primary: stored in `localStorage` via UI button
- Fallback: `legacy/src/config.js` (gitignored)
- `legacy/scripts/ensure-config.js` runs before legacy builds/tests to create a stub `config.js` if missing
- OpenAI client uses `dangerouslyAllowBrowser: true`

## Key Conventions

- **Title sanitization**: all titles → lowercase, spaces → underscores, special chars removed. Duplicates get `_1`, `_2` suffix.
- **@references**: typing `@` triggers project-wide autocomplete. References resolve to card content or document summaries and are included as bibliography context in AI prompts.
- **Images**: base64-encoded, stored inline in card JSON. Supported via paste or file attachment.
- Vanilla JS throughout; no TypeScript or linting.

