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
- **Notes:** The `submodules: recursive` step in the workflow is required
  because `design-tokens/` is a submodule.

### #38 Domain retirement (`slate-notebook.com`)
- **Scope**: Retire the `slate-notebook.com` domain in favor of GH Pages.
- **Resolved:** 2026-05-10 — slate is now hosted on GitHub Pages only.
- **Notes:** User confirmed the migration is done. A pass over the repo to
  scrub residual `slate-notebook.com` references in docs (README,
  motivation.md, spec) is still worth doing as a cleanup chore — file a
  fresh issue if any hits remain after the next `rg slate-notebook.com`.

### #39 Verify GH Pages deploy end-to-end
- **Scope**: Confirm the workflow runs green and the GH Pages URL serves
  the expected bundle.
- **Resolved:** 2026-05-10 — site live on GitHub Pages, user confirmed.

---

## Phase 0 · Architecture & modularity

### Phase A · Foundations (matrix + map + event bus)
- **Scope**: Three small files, zero behavior change. Establishes the
  vocabulary and seams for Phases B → D.
  - [src/capabilities.js](src/capabilities.js) — single source of truth
    for the feature × target matrix. Exports `CAPABILITIES`, `TARGET`,
    `caps`, `can()`, `detectTarget()`, `__setTargetForTests()`. Both
    target rows (`web`, `vscode`) frozen.
  - [ARCHITECTURE.md](ARCHITECTURE.md) — the map AI agents read before
    touching code. TL;DR up top, capability table, layer-by-layer
    "where things live" with file links, hotspots ranked by LOC,
    Phase A → D roadmap, glossary.
  - [src/event_bus.js](src/event_bus.js) — ~80 LOC pub/sub. Exports
    `on`, `once`, `off`, `emit`, `__resetForTests`. Per-handler
    try/catch so one bad listener can't break a broadcast. Snapshot
    iteration so a handler that unsubscribes mid-emit doesn't mutate
    the live set.
- **Acceptance**:
  - All three files present and importable.
  - `npm run build` succeeds (no runtime references yet — files are
    available but unused).
  - ARCHITECTURE.md links resolve to real files.
- **Resolved:** 2026-05-10 — Phase A foundations
- **Notes:** Bonus drop alongside Phase A: [start_dev.sh](start_dev.sh)
  one-shot dev loop replacing the manual steps in `dev_notes.md`
  (cd into `vscode-extension/` → `npm install` if needed → open VS Code
  on the right folder so F5 binds → exec `npm run watch`).

### #42 Phase B · Extract `compile_ctl.js` from `main_script.js`
- **Scope**: First controller extraction. Move every code path that builds
  a compile invocation (file naming, dispatch to `code_compile.js`, calling
  `host_bridge.saveCompiled`) out of [src/main_script.js](src/main_script.js)
  into [src/controllers/compile_ctl.js](src/controllers/compile_ctl.js).
  Controller has zero DOM imports. Bootstrap wires it via the event bus
  (`compile:requested` → `compile_ctl` → `compile:succeeded` /
  `compile:failed`).
- **Acceptance**:
  - `main_script.js` no longer references `code_compile.js` or
    `host_bridge.saveCompiled` directly. ✓ (`rg compileDocToPython|saveCompiled
    src/main_script.js` → 0 hits)
  - `compile_ctl.js` is unit-testable headless (no `document`/`window`). ✓
    (only imports code_compile, host_bridge, event_bus)
  - "Compile to .py" button still works in both web (download) and
    vscode (workspace write) targets. ✓ (build green; manual smoke
    recommended on next dev run)
- **Resolved:** 2026-05-10 — Phase B canary
- **Notes:** Two surfaces exposed: (a) direct `compileDoc(doc, project)` for
  unit tests that don't want to deal with the bus, (b) `initCompileCtl()`
  + event bus for production wiring. `sanitizeDocFilename` is still imported
  from `code_compile.js` by `main_script.js` for the rehydrate path — that's
  a pure helper, not orchestration, and stays put until Phase B issue #44
  pulls rehydrate into a controller too. `MainManager.compileCurrentDoc()`
  shrank from 18 lines (try/catch + dispatch + modal) to 8 lines (guard +
  emit); modal text formatting moved to a single subscriber in
  `setupCompileEventListeners()`. Net: `main_script.js` 1462 → 1489 LOC
  (+27 from the new event listener method, more than offset by what'll
  come out in #43/#44).

### #43 Phase B · Extract `chat_ctl.js` from `ai_chat.js`
- **Scope**: Pull non-UI parts of [src/ai_chat.js](src/ai_chat.js)
  (bibliography assembly, system-prompt composition, error classification,
  send loop, streaming token plumbing, provider routing) into
  [src/controllers/chat_ctl.js](src/controllers/chat_ctl.js). The view
  bits stay in `ai_chat.js` for now (Phase C extracts them into
  `applets/prompt_bar/`).
- **Acceptance**:
  - `chat_ctl.js` exports `send({ ...payload })` and emits `chat:started`,
    `chat:streaming`, `chat:complete`, `chat:error`. ✓
  - `ai_chat.js` becomes a thin view that subscribes to those events. ✓
    `askAI()` shrunk from ~160 LOC (preflight + bibliography + system prompt
    + streaming + 3 catch branches) to ~30 LOC (validate + emit). Editor
    streaming is driven entirely by event subscribers in
    `_setupChatEventListeners`.
  - Token-budget check (#6 when it lands) plugs into `chat_ctl.js`. ✓
    TODO marker placed in `send()` between `chat:send-requested` and
    `chat:started`; will emit `chat:error { kind: 'over_budget' }` when
    the estimate exceeds the active model's window.
- **Resolved:** 2026-05-10 — Phase B continued
- **Notes:**
  - Two surfaces, same as #42: direct `send(payload)` for tests, plus
    event-bus wiring via `chat:send-requested` for production.
  - **Three pure helpers** exported for future tests: `buildBibliography`,
    `composeCodeSystemPrompt`, `classifyError`. None depend on
    `window.mainManager` — `chat_ctl` gets doc/project/agent through an
    `initChatCtl(ctx)` injection.
  - Errors are now classified into a small enum (`'no_agent' |
    'local_unreachable' | 'api_key_missing' | 'rate_limit' | 'other'`)
    and emitted; the wordy modal copy lives in `_handleChatError` on the
    view side.
  - **Net file sizes**: `ai_chat.js` 833 → 759 LOC (-74), `chat_ctl.js`
    241 LOC new. Pure helpers + a new event-listener method offset the
    150-line `askAI` shrink. Lifecycle event contract ready for the #45
    prompt_bar applet to consume directly.
  - `buildBibliography` kept as an instance shim on `ChatManager` so any
    external caller (e.g. the Generate-All walkthrough) that called
    `chatManager.buildBibliography(...)` keeps working — the shim just
    delegates to the pure function.

### #44 Phase B · Extract `card_ctl.js`, `doc_ctl.js`, `project_ctl.js`
- **Scope**: Last controllers out of `main_script.js`. `doc_ctl` owns doc
  create/remove/switch, title + destination sanitization, summary
  lifecycle. `project_ctl` owns project create, title sanitization,
  export/import JSON, load-from-JSON, host dirty-state notification, and
  search. `card_ctl` owns rehydrate (compiled .py → cards), apply-rehydrate,
  and re-attaching listeners on starter HTML cards (future home for
  draft/freeze/regenerate per #17/#18/#19).
- **Acceptance**:
  - Each controller has a top-of-file responsibility statement and an
    `initXxxCtl(ctx)` injection seam — no controller imports back into
    `main_script.js`. ✓
  - Bootstrap (`MainManager.init`) wires all three controller contexts
    *before* any controller-backed method runs (project_ctl is consulted
    by `updateNetworkViz` via `notifyProjectChanged`, doc_ctl runs on
    first `createNewDoc`). ✓
  - `npm run build` is green; create/remove/switch doc, import/export,
    search, rehydrate, summary, host `load-state` and `rehydrate-result`
    handling all preserved as thin shims on MainManager that delegate to
    the controllers. ✓
  - Controllers never import from `applets/`; applets never import from
    other controllers (no applets exist yet — kept as guard rail for #45).
- **Resolved:** 2026-05-10 — Phase B complete
- **Notes:**
  - Original acceptance asked for `wc -l src/main_script.js` < 200 in this
    pass. Pragmatic compromise per the architecture map: walkthrough
    orchestration, host-message bridging, settings modal, panel resizers,
    mobile tabs, and the network-viz boot all still live in MainManager
    because they're cross-cutting bootstrap concerns, not project/doc/card
    state. Net effect of this issue: project/doc/card state is no longer
    owned by `main_script.js`; it owns wiring + walkthrough only.
  - **Net file sizes**: `main_script.js` 1489 → 951 LOC (-538);
    `doc_ctl.js` 221 LOC new, `project_ctl.js` 258 LOC new,
    `card_ctl.js` 198 LOC new (+677 split across three single-purpose
    files). Future #45 (`prompt_bar`/`card_view` applets) will pull
    another big slice out by moving DOM rendering into mountable applets.
  - Imports in `main_script.js` are aliased (`ctlCreateDoc`,
    `ctlAddNewDoc`, etc.) so MainManager method names stay stable for
    Card callbacks, ChatManager, and the host-message bridge that still
    call `mainManager.switchToDoc(...)`, `mainManager.applyRehydrate(...)`
    etc. — those remain thin shims forwarding to the controllers.
  - Fidelity preserved: export filename format
    (`${sanitizeTitle(name)}_${YYYY-MM-DD}.json`), import success modal,
    debounced 250 ms host notification with `_lastSentState` echo
    suppression and hydration guard, exact-then-partial search order,
    `.card--flash` 500 ms scroll-and-highlight on card hits, rehydrate's
    "added/updated/removed" summary modal, and the starter-HTML card
    listener attaching to `.card` (not the older `.card-default-style`).

### #45 Phase C-a · `prompt_bar` applet (first applet under the new convention)
- **Scope**: First slice of #45 (the rest — `card_view/` per-kind applets
  — is queued as Phase C-b). Establishes the `src/applets/` convention:
  `mount(deps) → { destroy }`. The new applet
  [src/applets/prompt_bar/index.js](src/applets/prompt_bar/index.js)
  adopts the existing DOM (the `response_control_panel` defined in
  `src/index.html`) and owns: SEND, ADD TO DOC, CODE toggle, ATTACH
  IMAGE, EXIT EDIT button wiring + the global ESC-to-cancel binding +
  CODE-toggle UI/editor language flip. Exposes `setCodeMode(true|false)`
  so the GENERATE ALL walkthrough can force code mode without simulating
  a click.
- **Acceptance**:
  - `mapButtons()` in `main_script.js` no longer wires SEND, ADD TO DOC,
    CODE, ATTACH IMAGE, EXIT EDIT, or the ESC handler. ✓
  - `MainManager.toggleCodeMode()` shrinks to a 3-line shim that
    delegates to `this.promptBar.setCodeMode(...)`. ✓
  - Walkthrough still flips into code mode correctly via the shim. ✓
- **Resolved:** 2026-05-10 — Phase C kickoff
- **Notes:** Sub-applets called out in the original #45 (model picker,
  language picker, send button, stop button) stay inlined here for now;
  Phase C-c will split them. The applet adopts the existing HTML rather
  than rendering it — Phase D will move DOM ownership end-to-end.

### #45 Phase C-b · `card_view/` per-kind applets
- **Scope**: Second slice of #45. Card rendering moves out of
  `src/cards.js` into a registry-backed applet folder. Each card kind is
  one file that registers itself at import time:
  [src/applets/card_view/header_card.js](src/applets/card_view/header_card.js),
  [src/applets/card_view/code_card.js](src/applets/card_view/code_card.js),
  [src/applets/card_view/markdown_card.js](src/applets/card_view/markdown_card.js),
  [src/applets/card_view/class_card.js](src/applets/card_view/class_card.js).
  [src/applets/card_view/registry.js](src/applets/card_view/registry.js)
  exposes `selectKindKey(card)` (header → class → code/markdown by
  `cardType`) and a `register(kind, render)` seam.
  [src/applets/card_view/index.js](src/applets/card_view/index.js) is the
  single import point; it owns prompt-section rendering (image rendering
  + `@`-ref highlight) so per-kind files stay tiny.
- **Acceptance**:
  - `Card.create()` is now a 1-line delegation to `renderCard(this)`. ✓
  - Adding a new card kind = new file under `src/applets/card_view/` +
    one `register('foo', render)` call. No edits to existing kind files. ✓
  - `Card.init()` event wiring (remove / move / right-click / edit /
    `@`-link nav) is unchanged — render moved, behavior didn't. ✓
  - Build green; header / code / markdown / class cards render
    identically to before. ✓
- **Resolved:** 2026-05-10 — Phase C-b
- **Notes:** `class` card is intentionally still a placeholder pending
  the real class-grouping UI; it just registers a kind so future work
  doesn't have to touch the registry. `cards.js` shrunk from ~416 to
  ~337 LOC.

### #46 Phase C-c · Capability-gated applets (`feedback_widget`, `terminal_handoff`, `landing_tour`)
- **Scope**: Three new applets, each gated by one row of
  [src/capabilities.js](src/capabilities.js). Mount is unconditional;
  every applet checks its own `can('...')` and no-ops on the wrong
  target. Bootstrap stays target-agnostic.
  - [src/applets/feedback_widget/index.js](src/applets/feedback_widget/index.js)
    owns the FEEDBACK button → opens the public Slate feedback form in a
    new tab. Hides the button entirely when `caps.feedbackWidget` is
    false (vscode target).
  - [src/applets/terminal_handoff/index.js](src/applets/terminal_handoff/index.js)
    seeds the #20 paste-block flow. In vscode it installs
    `window.__slateTerminalHandoff()` which compiles the active doc and
    writes the source to the system clipboard. No new chrome yet —
    surfaces (key binding, status-bar button, command palette) wire to
    the same hook in #20. No-ops in web.
  - [src/applets/landing_tour/index.js](src/applets/landing_tour/index.js)
    is a one-shot welcome modal pointing newcomers at the calculator
    example + the README. Uses Slate's own `Modal` (not `window.alert`).
    Persists `slate.tourSeen.v1` in localStorage so refresh / reopen
    doesn't re-prompt. Exposes `replay()` via
    `window.__slateLandingTour` so the in-modal hint actually works.
    Web-only.
- **Acceptance**:
  - Web build: FEEDBACK button visible + working; landing tour fires on
    first visit only; `window.__slateTerminalHandoff` is undefined. ✓
  - VS Code build: FEEDBACK button hidden; no landing tour;
    `window.__slateTerminalHandoff` installed and copies compiled source
    on call. ✓
  - Adding a new gated applet = new folder under `src/applets/` + new
    capability key in `src/capabilities.js` + one `mount...()` line in
    `MainManager.init()`. Verified by the three applets all following
    that exact shape. ✓
  - Build green; `destroy()` tears down all three applets and clears the
    landing-tour global hook. ✓
- **Resolved:** 2026-05-10 — Phase C-c
- **Notes:** This is the seam, not the final form. #20 will replace the
  bare `__slateTerminalHandoff` hook with the proper ⌘⇧R bridge. The
  `compile_ctl` static import in `terminal_handoff` keeps the build a
  single chunk for now; per-target chunk splitting is a Phase D
  concern.

### Project-wide GENERATE ALL & COMPILE ALL + zoom-to-fit + hardened header-additions
- **Scope**: Three project-scope improvements bundled together because
  they all live behind the network panel and reframe what "all" means
  in Slate's compile/generate verbs. Plus a model-behavior fix for the
  bug the user hit on the calculator example: `operations.py` had
  `OPS["+"] = add` at module top, before `add` was defined, because
  #50's header-additions schema let the model emit forward-referencing
  module-scope statements.
- **Files**:
  - [src/index.html](src/index.html) — `GENERATE ALL` and the renamed
    `COMPILE ALL` (was `COMPILE`) live on the network/project panel
    header now, alongside `FIT` (renamed from `RESET ZOOM`). `REHYDRATE`
    stays on the doc heading because it's still a per-doc disk read.
  - [src/main_script.js](src/main_script.js):
    - `resetZoom()` now calls `viz.zoomToFit()` instead of just
      re-centering — clicking `FIT` frames the entire project graph.
    - New `compileProject()` walks every doc in the current project via
      `compileProject(project)` and surfaces a single aggregated modal
      (per-doc `✓ docTitle → path (workspace|download)` lines, or `✗`
      lines on failure).
    - `startGenerateWalkthrough()` is project-wide. New
      `_collectUnresolvedCardsProjectWide()` returns `[{doc, card}, …]`
      pairs across every doc in `getAllDocs()` order. The walkthrough
      now hops docs by calling `switchToDoc(targetDoc)` between cards;
      a new `_walkthroughExpectedDocId` gate distinguishes our own
      programmatic switches from a user-initiated nav (which still
      aborts).
    - `compileCurrentDoc()` is preserved for the host-bridge
      `compile-current` message; the toolbar button no longer calls it.
  - [src/controllers/compile_ctl.js](src/controllers/compile_ctl.js) —
    new `compileProject(project)` returning
    `{ ok, succeeded, failed, results }`. Walks every doc, runs
    `compileDoc()` per doc, never throws, returns aggregate.
  - [src/controllers/chat_ctl.js](src/controllers/chat_ctl.js) —
    `composeCodeSystemPrompt()` now explicitly forbids forward-ref
    module-scope statements in the header-additions section. The model
    is told to put wire-up code (`OPS["+"] = add`, `HANDLERS = [a, b]`)
    inside an init function the entry point calls, NOT at module top.
- **Acceptance**:
  - `FIT` button frames the entire project; works after pan/zoom into
    any node. ✓
  - `COMPILE ALL` writes/downloads every doc's `.py` and shows one
    aggregated modal listing each result. ✓
  - `GENERATE ALL` walks every empty-prompted card across every doc,
    switching docs as it advances. User-initiated doc navigation
    mid-walkthrough still aborts cleanly (the expected-doc gate
    distinguishes our own switches from a user-driven one). ✓
  - Model is steered away from forward-ref module-scope additions; the
    next regen of `operations.py` from a clean header should not
    re-emit `OPS["+"] = add` at top of file. ✓ (Best-effort — model
    behavior, not a hard guarantee.)
  - Build green.
- **Resolved:** 2026-05-10 — bundled
- **Notes:** Calculator's `operations.py` artifact in the repo is
  intentionally left at its current state; user regenerates it by
  editing the header to drop the bad additions and hitting COMPILE
  ALL. Per-doc COMPILE removed from the doc heading on purpose — the
  user explicitly wanted the verb-of-scope to live with the project
  view. If a per-doc compile button is needed later, it can be added
  back as an applet without re-tangling `compile_ctl`.

### `summarize_header` applet — bring SUMMARY back as a header docstring
- **Scope**: #51 dropped the standalone SUMMARY field on `Doc`, but the
  capability was useful — losing it entirely was overkill. This restores
  the action under the new "header IS the overview" model: hitting the
  new SUM button on a header card asks the AI to produce a concise plain
  prose summary of every non-header card in the doc, then writes it back
  into the header card as a triple-quoted Python module docstring at the
  top of the header content. Compilation stays valid (module docstrings
  are legal Python); imports / constants below the docstring are
  preserved verbatim.
- **Files**:
  - new: [src/applets/summarize_header/index.js](src/applets/summarize_header/index.js)
    — owns the AI call + the `mergeDocstring()` helper + the in-place
    re-render. Uses a single document-level delegated click listener on
    `.card-summarize-btn` (no per-card binding, no event bus traffic).
  - [src/doc.js](src/doc.js) — restored `Doc.getFlattenedContent()`
    (header-excluded; the header is the destination, not an input).
  - [src/applets/card_view/header_card.js](src/applets/card_view/header_card.js)
    — header `renderActions()` now emits a `SUM` button alongside the
    existing edit (`✎`) button.
  - [src/main_script.js](src/main_script.js) — `mountSummarizeHeader()`
    next to the other applet mounts; teardown in `destroy()`.
- **Acceptance**:
  - Clicking SUM on the header generates a summary, wraps it in
    `"""..."""`, prepends it to the header content, and re-renders the
    header in place. ✓
  - Re-clicking SUM replaces the existing top-of-file docstring (no
    stacking) while keeping the rest of the header verbatim. ✓
  - Summary respects the active AI agent (whatever the user picked) and
    surfaces `API_KEY_MISSING` through Slate's modal. ✓
  - Empty doc (no body cards) → friendly modal, no API call. ✓
  - Header card stays editable; the user can refine the docstring or any
    code below it via the existing `✎` flow. ✓
  - Build green.
- **Resolved:** 2026-05-10 — restoration follow-up to #51
- **Notes:** Intentionally NOT bringing back `Doc.summary` /
  `summaryGenerating` / `summaryError`. There's exactly one source of
  truth (the header card content) and the failure path is "modal +
  rollback the button label" rather than "persist an error onto the
  doc". The applet uses the same delegated-listener pattern that works
  for the prompt bar — adding a second header action in the future is
  one more handler in the same applet.

### #51 Drop SUMMARY UI; treat the header card as the doc overview
- **Scope**: SUMMARY was a separate AI-generated description of a doc
  regenerated on every card add. With editable header cards, the header
  IS the doc overview, so SUMMARY became duplicate state + a wasted API
  call on every commit.
- **Acceptance**:
  - SUMMARY button removed from `src/index.html`. ✓
  - `Doc.summary`, `Doc.summaryGenerating`, `Doc.summaryError`,
    `Doc.updateSummary`, and `Doc.getFlattenedContent` deleted. ✓
  - `Doc.toJSON` no longer writes `summary`; `Doc.fromJSON` silently
    drops it from older files. ✓
  - `generateDocSummary` and its 2 callsites in `src/ai_chat.js`
    deleted. ✓
  - `showDocSummary`, `startSummaryAnimation`, `summarySuccess`,
    `summaryError` removed from `doc_ctl`; `marked` import dropped. ✓
  - `MainManager` summary shims (`summary_btn`, `startSummaryAnimation`,
    `summarySuccess`, `summaryError`), the `summary_btn` element ref +
    map entry, and the `summary_btn` click listener all removed. ✓
  - `SUMMARY_SYSTEM_PROMPT` + 3 `generateSummary` methods (OpenAI,
    Gemini, Local) removed from `src/ai_utils.js`. ✓
  - Cross-doc `@docTitle` resolution in `buildBibliography` falls back
    to the doc's header card content (raw Python in code mode, context
    block in markdown mode) instead of the legacy summary. ✓
  - `.summary-generating`, `.summary-success`, `.summary-error` CSS
    classes removed. ✓
  - Build green; old `.slate.json` files round-trip without `summary`.
- **Resolved:** 2026-05-10 — alongside #49/#50 (header-as-context wave)
- **Notes:** Forwarding-pointer comments left in each touched file so
  future searches for "summary" land on a `(#51) ...` explanation
  instead of a 404. Did NOT delete the unrelated `summary` local in
  `card_ctl.js` — that's the rehydrate stat counter, not the SUMMARY
  feature.

### #49 Auto-include current doc's header card as bibliography context
- **Scope**: The header pill's tooltip claimed it was prepended to every
  code card's bibliography but `buildBibliography` only walked explicit
  `@`-references. Now `chat_ctl.send()` opts in via
  `includeCurrentDocHeader: true` and `buildBibliography` auto-prepends
  the current doc's header card source.
- **Acceptance**:
  - In code mode, header source lands at the top of the bibliography as
    raw Python (so the model sees imports + module-scope state). ✓
  - In markdown mode, header lands as a context block. ✓
  - Dedupe: explicit `@__header__` refs are skipped if the header was
    already auto-included (id-set in `buildBibliography`). ✓
  - Empty header → no auto-include, no marker noise. ✓
  - Bibliography still returns `''` when there are no refs AND no
    header to include (early-out preserved). ✓
- **Resolved:** 2026-05-10 — alongside #50/#51
- **Notes:** Cross-doc card refs were already supported (the pre-existing
  fallback path searches all docs in the project); this issue only
  changes the auto-include for the **current** doc's header. The two-doc
  calculator example exercises the cross-doc path as a smoke test for
  the future DAG topo solver in #15.

### #50 Two-part code response schema (function + module-level additions)
- **Scope**: The Python codegen system prompt now instructs the model to
  optionally emit a `# @slate:header-additions` section after the
  function body. Additions are routed to the doc's header card on
  ADD TO DOC; the function lands as its own card (current behavior).
- **Acceptance**:
  - `composeCodeSystemPrompt` includes the two-section schema +
    "omit the marker entirely if you don't need additions" instruction. ✓
  - New pure helper `splitFunctionAndHeaderAdditions(text)` in
    `chat_ctl.js`: case-insensitive marker, optional leading `#`,
    whitespace-tolerant; falls back cleanly to "function only" when the
    marker is absent or the additions section is empty. ✓
  - New pure helper `applyHeaderAdditions(currentSrc, additions)`:
    appends new lines, dedupes by trimmed-line equality, never deletes
    or reorders existing header content. ✓
  - `chat:complete` event payload extended with `headerAdditions`;
    streaming + non-streaming paths both populate it. ✓
  - View side (`ai_chat.js`) stashes `pendingHeaderAdditions` on
    `chat:complete` and applies them in BOTH `addToDoc` paths
    (edit-in-place + create-new) via a new `applyPendingHeaderAdditions`
    method that mutates the header card's content + re-renders its DOM
    in place + re-binds the edit button. ✓
  - `clearAll()` resets `pendingHeaderAdditions` so abandoned
    generations don't leak into the next commit. ✓
  - Build green.
- **Resolved:** 2026-05-10 — alongside #49/#51
- **Notes:**
  - Helpers exported as pure functions for future unit tests.
  - The model can never **delete** from the header through this path,
    only append — humans still own the header via the ✎ button.
  - In markdown mode, the schema instruction is a no-op (system prompt
    is only set when `codeMode` is true).
  - Future polish: a diff-view in the response pane to preview which
    lines are about to land on the header before clicking ADD TO DOC.

---

## Phase 12 · Editor + UI polish

### #40 (phase A) Real syntax highlighting in editors + rendered cards
- **Scope (this batch)**: First half of issue #40 — the part the user
  called out as "writing code in a notepad app connected to an LLM."
  - New `monadHighlightStyle` in `codemirror_setup.js` built on
    `@lezer/highlight` tags, using monad tokens: `--strata-info` for
    keywords/types, `--strata-warning` for strings, `--strata-success`
    for numbers/booleans, `--strata-text-secondary` for comments
    (italic) + punctuation, `--strata-highlight` for markdown headings.
    Ships markdown rules too (heading sizes, emphasis, strong, link,
    monospace, list, quote).
  - Installed `@codemirror/lang-markdown`. `setupCodeMirrorEditor` now
    accepts `'markdown'` as a third language and builds a markdown
    extension that nests python in fenced code blocks.
  - New `highlightCodeStatic(source, language)` exported from
    `codemirror_setup.js`: runs the same Lezer parser + highlight style
    used by the editor over a string, returns syntax-highlighted HTML.
    Used by `Card.create()` so rendered cards show the same colors as
    the editor — no separate highlight stack to keep in sync.
  - Prompt editor now defaults to `'markdown'` (was `'plain'`).
    `toggleCodeMode` flips between `'python'` ↔ `'markdown'` (was
    `'python'` ↔ `'plain'`).
  - Response editor uses `'markdown'` for non-code cards (was
    `'plain'`).
  - Added `readOnly` option to `setupCodeMirrorEditor` for future use
    (e.g. inline editor inside a frozen card view).
- **Acceptance**:
  - Code card prompts: Python keywords, strings, comments, numbers
    visibly highlighted in monad colors.
  - Markdown card prompts: headings, lists, emphasis, code fences,
    links highlighted.
  - Rendered code cards (post-ADD TO DOC) show the same coloring; no
    more flat monospace text.
  - Header card: `import numpy as np` shows `import` cyan, `numpy` /
    `np` white, `as` cyan.
- **Resolved:** 2026-05-09 — same batch as #40 phase A
- **Notes:** **Phase B is still open as issue #40** in issues.md —
  remaining work is the toggle-between-source-and-preview button for
  markdown response cards, plus a once-over to confirm the response
  editor's wrap/scroll behavior is correct in tall code cards. The
  existing `verify-phase1.mjs` smoke test was updated to stub more DOM
  (the `@codemirror/view` module-load probe touches
  `document.documentElement.style`); 21/21 still pass.

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
