# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Slate is a client-side graph-based document editor with AI-powered card creation. It uses vanilla ES6+ JavaScript (no framework) with Vite as the build tool. The app runs entirely in the browser — no backend server.

Live demo: www.slate-notebook.com

## Commands

```bash
npm run dev        # Start dev server (auto-opens browser)
npm run build      # Production build to dist/
npm run preview    # Preview production build
npm run serve      # Preview with --host flag
npm run clean      # Remove dist/
```

There is no test framework configured. No linter or formatter is set up.

## Architecture

### Data Hierarchy

```
Project → Document[] → Card[]
```

Each Card stores: title, content (rendered markdown HTML), prompt (original text), images (base64), and links (parsed @references). All data serializes to/from JSON for import/export.

### Source Layout (all in `src/`)

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

Vite config (`vite.config.js`):
- Root: `src/`
- Public dir: `design-tokens/build/` (monad.css/js served as static assets)
- Output: `dist/`

### API Key Management

- Primary: stored in `localStorage` via UI button
- Fallback: `src/config.js` (gitignored)
- `scripts/ensure-config.js` runs pre-build to create a stub `config.js` if missing
- OpenAI client uses `dangerouslyAllowBrowser: true`

## Key Conventions

- **Title sanitization**: all titles → lowercase, spaces → underscores, special chars removed. Duplicates get `_1`, `_2` suffix.
- **@references**: typing `@` triggers project-wide autocomplete. References resolve to card content or document summaries and are included as bibliography context in AI prompts.
- **Images**: base64-encoded, stored inline in card JSON. Supported via paste or file attachment.
- **No TypeScript, no linting, no tests** — vanilla JS throughout.

## License

CC BY-NC-ND 4.0 (Indrajeet Haldar)
