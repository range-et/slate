---
tags: [project, slate, slate-code, features, v0.2]
status: living
---

# slate-code — shipped features

This file is the **append-only log of resolved issues**. When an issue ships:

1. Cut the issue's full block from [issues.md](issues.md).
2. Paste it under the matching phase heading below.
3. Append a `**Resolved:** YYYY-MM-DD — <commit-sha-or-PR-link>` line at the
   bottom of the block.
4. Add a one-line `**Notes:**` if anything diverged from the original
   acceptance criteria (deferred sub-scope, follow-up issues filed, etc.).

Phase headings are pre-seeded so resolved issues land in the right place
without churn.

---

## Phase 1 · Header card primitive

### #1 Add `kind` field to Card and migrate existing data
- **Scope**: Add `kind: 'header' | 'body' | 'class'` to `Card` constructor with
  default `'body'`. Round-trip through `toJSON`/`fromJSON`. Backward-compat
  default for missing field.
- **Acceptance**:
  - Loading any pre-v0.2 project JSON produces all body cards (`kind: 'body'`)
    with no warnings.
  - Saving + reloading a project preserves `kind` exactly on every card.
  - Existing tic-tac-toe-style smoke test (`npm run dev`, create project, add
    cards, refresh) shows no regression.
- **Blocks**: #2, #3, #4
- **Files**: `src/cards.js`, `src/doc.js` (round-trip)
- **Resolved:** 2026-05-09 — phase 1 batch (`scripts/verify-phase1.mjs` 21/21 ✓)
- **Notes:** Added `CARD_KIND_HEADER`/`BODY`/`CLASS` constants and
  `HEADER_CARD_TITLE = '__header__'` in `src/cards.js`. `kind` is the 8th
  Card constructor arg with `isValidCardKind()` guard. JSON round-trip
  added in `Doc.toJSON`/`fromJSON`; `CARD_KIND_CLASS` already accepted by
  serde for forward-compat with phase 5.

### #2 Auto-create header card on `Doc.init()`
- **Scope**: Every new `Doc` gets exactly one `kind: 'header'` card at index 0
  with title `__header__` and empty source. Pre-existing docs without a header
  get one synthesized on first save.
- **Acceptance**:
  - `new Doc('foo'); doc.init();` → `doc.cards.length === 1`, `doc.cards[0].kind === 'header'`.
  - Loading an old project without headers → save → reload shows a header card
    on every doc.
  - Header card cannot be removed via `removeCard()` (returns false; logs a
    warning).
- **Blocks**: #3, #4, #5, header-aware compile (#22), bibliography injection (#27)
- **Files**: `src/doc.js`, `src/header_card.js` (new)
- **Resolved:** 2026-05-09 — phase 1 batch
- **Notes:** Synthesized on `Doc.fromJSON()` (not just on save) so legacy
  projects show the header immediately on load. The `src/header_card.js`
  factory was inlined as `buildHeaderCard()` in `src/doc.js` — single
  call site, didn't earn a separate module yet. Will extract when phase 2's
  bibliography injection needs to share the helper.

### #3 Header card UI rendering
- **Scope**: Header card renders above the doc title with monad-accent border,
  "header" pill badge, no `[× remove]`, no `[↗ move]` button. Editable
  inline.
- **Acceptance**:
  - Visual diff: header card visibly distinct from body cards in dev server.
  - Remove button absent; move button absent.
  - Editing header card content persists across reload.
- **Blocks**: #6 (one-click "extract imports")
- **Files**: `src/cards.js` (`create()` branch on `kind`), `src/styles.css`
- **Resolved:** 2026-05-09 — phase 1 batch
- **Notes:** Used `--strata-success` (green, 3px left border) so header
  cards don't visually collide with `card--code` (cyan). "header" pill in
  the title row. Edit button (✎) preserved; move + remove buttons omitted
  by branching the `actionsHTML` template. Empty-header state shows a
  one-line monospace hint to invite the user to add imports. Header card
  renders as the first card in the doc-content list (not floated above
  the doc title separately) — visually distinct via chrome, satisfying
  the acceptance criterion. Editing routes through the existing
  `loadCardForEdit` / `editingCard` flow, so persistence is identical
  to body cards. **Manual visual check still recommended via the dev
  loop in `DEV.md`.**

### #4 Forbid duplicate header cards & enforce position 0
- **Scope**: `addCard()` rejects a second `kind: 'header'` card per doc.
  Header card always sorts to index 0; cannot be moved.
- **Acceptance**:
  - Adding a second header card returns false + logs a warning.
  - Moving a body card to index 0 still leaves the header at 0 (header is pinned).
- **Blocks**: nothing critical
- **Files**: `src/doc.js`
- **Resolved:** 2026-05-09 — phase 1 batch
- **Notes:** `addCard` returns boolean (was previously side-effect-only);
  header insertion uses `unshift` to pin position 0; body cards always
  `push` after the existing header. Card.moveToAnotherDoc was not
  modified — header cards have no move button per #3, so the path is
  unreachable from UI; if invoked programmatically the rejection happens
  at the destination doc's addCard via the duplicate-header guard.

---

## Phase 2 · System prompt + 16K budget enforcement

*(no issues resolved yet)*

---

## Phase 3 · Streaming + cancel

*(no issues resolved yet)*

---

## Phase 4 · Code-card schema migration

*(no issues resolved yet)*

---

## Phase 5 · Card hierarchy (class → methods)

*(no issues resolved yet)*

---

## Phase 6 · Cell-as-sandbox loop, manual mode

*(no issues resolved yet)*

---

## Phase 7 · Target/language registry

*(no issues resolved yet)*

---

## Phase 8 · Prompt-bar UI overhaul + shortcuts

*(no issues resolved yet)*

---

## Phase 9 · Tic-tac-toe example + CI

*(no issues resolved yet)*

---

## Phase 10 · Hosting freeze

*(no issues resolved yet)*

---

## Cross-cutting decisions

*(no decisions resolved yet)*

---

## Phase 11 · Web deployment + decoupling

### #37 GitHub Pages deploy workflow
- **Scope**: `.github/workflows/pages.yml` builds the slate web bundle on
  push to `main` and deploys to GitHub Pages. Vite's `base` honors the
  `BASE_URL` env var so assets resolve under `/<repo>/`.
- **Acceptance**:
  - Workflow file present and well-formed.
  - `npm run build` honors `BASE_URL=/slate/` (verified locally — index.html
    references assets under the configured base).
- **Blocks**: #38, #39
- **Files**: `.github/workflows/pages.yml` (new), `vite.config.js` (added
  `base` from env)
- **Resolved:** 2026-05-09 — alongside the styling fixes
- **Notes:** End-to-end verification is issue #39 (still open) — needs the
  first push to `main` to trigger Actions and Pages settings to be flipped
  to "Source: GitHub Actions" in the repo. The `submodules: recursive`
  step in the workflow is required because `design-tokens/` is a submodule.

---

## Phase 12 · Editor + UI polish

### Autocomplete dropdown monad theming + editor font size reduction
- **Scope** *(part of in-flight #40 from issues.md, plus an interim fix
  for the jarring white autocomplete)*:
  - Move CodeMirror autocomplete styles out of the `EditorView.theme`
    inline block (which gets out-prioritized because the tooltip is
    portaled outside the editor's scope) into `styles.css` with global
    selectors and `!important`. Match monad palette: `--strata-layer-01`
    background, `--strata-text-primary` text, `--strata-info` accent for
    selection.
  - Reduce default editor font from CM's `"medium"` (~16px) to
    `var(--type-sm)` (~12.5px at 14px base) and switch the editor scroller
    to the mono font for code-mode legibility.
  - Reduce response pane font from `var(--type-base)` to `var(--type-sm)`.
- **Acceptance**:
  - Autocomplete dropdown matches the rest of the slate UI (dark
    background, mono labels, info-accent selection); no white-on-black
    jarring break.
  - Prompt + response editors render at a reasonable size for code work
    (was visibly too large per the shipped screenshots).
- **Resolved:** 2026-05-09 — alongside the GH Pages workflow
- **Notes:** Full VS-Code-like editor experience (Python + markdown
  syntax highlighting, editable response in source mode) is still open as
  issue #40 — this batch addresses only the visual polish part. The font
  reduction also makes more content fit on screen, which matters once the
  bibliography preview (#27) lands above the prompt.

---

## Pre-v0.2 (already shipped, for context)

The v0.1 work from [slate-code-plan.md](slate-code-plan.md) is the baseline
this v0.2 plan builds on. Brief recap of what's already in the codebase as
of v0.2 spec start:

- Local Ollama agent (`LocalAgent` in `src/ai_utils.js`)
- Code card type (`cardType: 'code'`) — to be migrated to `language` (#9)
- Python compile path (`src/code_compile.js`) — to be moved + extended (#11, #21)
- VS Code extension shell (`vscode-extension/`) — to be expanded (#20, #22)
- Doc destination field — to be folded into target system (#21)

These are not re-listed as resolved issues here because they predate the
v0.2 issue numbering.

---

*Related: [issues.md](issues.md) · [slate-code-v0.2-spec.md](slate-code-v0.2-spec.md) ·
[slate-code-plan.md](slate-code-plan.md)*
