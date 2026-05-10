---
tags: [project, slate, slate-code, issues, v0.2]
status: open
---

# slate-code v0.2 — open issues

Source of truth: [slate-code-v0.2-spec.md](slate-code-v0.2-spec.md).
When an issue ships, **move its block verbatim into [features.md](features.md)**
under the same heading and add a `Resolved:` line with date + commit/PR link.

Issues are grouped by phase from the spec's §Sequencing. Within a phase,
issues are ordered by dependency. Each issue lists:
- **Scope** — the bounded change
- **Acceptance** — the success metric (binary, testable)
- **Blocks** — issues that depend on this one
- **Files** — primary files touched (advisory; not exhaustive)

---

## Phase 1 · Header card primitive

*All phase 1 issues shipped — see [features.md](features.md#phase-1--header-card-primitive).*

---

## Phase 2 · System prompt + 16K budget enforcement

### #5 Ship `python.system.txt` system prompt
- **Scope**: Create `src/compilers/prompts/python.system.txt` with the spec
  §8 ruleset (one Python def, no prose, no fences, `SLATE_CANNOT_GENERATE`
  escape hatch). Wire into `ai_chat.js` so code-card generation uses it
  instead of the markdown system prompt.
- **Acceptance**:
  - A code card generated via local Ollama returns either valid Python or
    a `# SLATE_CANNOT_GENERATE: ...` line, never markdown prose.
  - Markdown card generation is unchanged (uses original system prompt).
- **Blocks**: #7, #14
- **Files**: `src/compilers/prompts/python.system.txt` (new), `src/ai_chat.js`

### #6 Token-budget estimator + pre-send warning
- **Scope**: Implement `src/token_budget.js` with a char/3.5 heuristic.
  Per-model window config (default 16K - 2K headroom = 14K input budget).
  Pre-send: estimate full assembled context (system + header + refs +
  draft.chat + new message); if over budget, surface a modal listing what's
  blowing it (sorted by token cost). Refuse-on-overflow unless user shrinks.
- **Acceptance**:
  - A code card with a 20K-token `@ref` blocks send, shows the modal.
  - Same card with refs trimmed sends successfully.
  - Markdown cards bypass the strict refuse (warning only — they're cloud,
    bigger windows).
- **Blocks**: #7
- **Files**: `src/token_budget.js` (new), `src/ai_chat.js`

---

## Phase 3 · Streaming + cancel

### #7 Streaming response render in prompt area
- **Scope**: Switch local-provider generation to streaming via Ollama's
  OpenAI-compatible API. Render token-by-token into the prompt area's
  response surface. Markdown providers can stream too if their SDK supports
  it; otherwise stay non-streaming.
- **Acceptance**:
  - With Ollama running, a code-card generation visibly streams tokens
    (no perceptible "wait → dump" lag).
  - Final committed text matches concatenated stream.
- **Blocks**: #8
- **Files**: `src/ai_utils.js`, `src/ai_chat.js`

### #8 Stop button + `⌘.` shortcut
- **Scope**: Visible `[■ STOP]` button while streaming. `⌘.` shortcut
  triggers same handler. On stop, abort the request, discard the partial
  response (don't commit to draft).
- **Acceptance**:
  - Click STOP mid-stream → response halts, no draft updated.
  - `⌘.` while streaming → same behavior.
  - After stop, the prompt is preserved (user can edit and retry).
- **Blocks**: nothing critical
- **Files**: `src/main_script.js`, `src/ai_chat.js`

---

## Phase 4 · Code-card schema migration

### #9 Replace `cardType` with `language` field
- **Scope**: Add `language: 'markdown' | 'python' | 'cpp' | 'csharp' | 'javascript'`
  to Card. Migration shim: `cardType: 'code'` → `language: 'python'`,
  `cardType: 'markdown'` → `language: 'markdown'`. Drop reading `cardType`
  going forward (writes only `language`).
- **Acceptance**:
  - Pre-v0.2 JSON loads, every card has `language` set.
  - Round-trip preserves `language`; saves do not write `cardType`.
- **Blocks**: #10, #11, #18
- **Files**: `src/cards.js`, `src/doc.js`, `src/migrations.js` (new)

### #10 Split `content` → `source` for code cards; introduce `draft`, `frozen`, `metadata`
- **Scope**: Code cards (`language !== 'markdown'`) drop `content`; add
  `source`, `draft` (nullable), `frozen` (default false), `metadata`
  (model/provider/generatedAt/tokensUsed/iterations/distilledBy). Migration:
  run existing `getPythonSource()` on old cards, store as `source`. Markdown
  cards keep `content` unchanged.
- **Acceptance**:
  - Old project with code cards loads; their `source` matches what
    `getPythonSource()` would have returned previously.
  - Round-trip stable (save → reload → diff is empty).
  - Markdown cards untouched.
- **Blocks**: #11, #12, #13
- **Files**: `src/cards.js`, `src/migrations.js`

### #11 + #12 — superseded by #53 (round-trip annotations)
- **Status**: **Superseded** on 2026-05-10. The annotation work originally
  planned here landed under issue #53 (round-trip code edits). See
  [features.md → #53](features.md#53-phase-e--round-trip-code-edits-from-py-back-into-cards)
  for the shipped surface (`## @slate id=… kind=… title=… doc=…` +
  `## prompt:` blocks emitted by the compiler, header card prepended via
  the same path, parser in [src/slate_annotations.js](src/slate_annotations.js)).
- The original `# @slate-meta:` `model=… generated_at=… iterations=N` fields
  from #11 were not implemented because they belong to the freeze loop
  (#16–#19), which hasn't shipped. When freeze lands, extend
  `emitAnnotation` in [src/slate_annotations.js](src/slate_annotations.js)
  to include those fields — the format already tolerates unknown extra
  `key=value` pairs (verified by
  [test/slate_annotations.test.js](test/slate_annotations.test.js)).
- The `# (was-@slate)` collision-escaping rule from #11 is **not** needed
  for the chosen `## @slate` (double-hash) prefix, which doesn't collide
  with anything users normally write.

---

## Phase 5 · Card hierarchy (class → methods)

### #13 Add `parentCardId` and `kind: 'class'` support to Card
- **Scope**: Card gains `parentCardId: string | null` (null for top-level).
  `kind: 'class'` is a valid value. Round-trip through JSON. UI renders
  method cards (cards whose `parentCardId` matches a class card in the same
  doc) indented under their parent.
- **Acceptance**:
  - A doc with one class card + two method cards persists and reloads with
    nesting intact.
  - UI shows method cards indented under the class card; click class card
    folds/unfolds methods.
  - Removing a class card with children prompts the user (cascade delete or
    re-parent to top-level).
- **Blocks**: #14, #21 (compile nesting)
- **Files**: `src/cards.js`, `src/doc.js`, `src/styles.css`

### #14 Python compiler nests methods under class
- **Scope**: When emitting code, the compiler walks top-level cards.
  For each `kind: 'class'` card, emits its source verbatim, then for each
  card with `parentCardId === classCard.id`, indents the method source 4
  spaces and emits inside the class block. Strip class card body if it's
  only `pass`.
- **Acceptance**:
  - tic-tac-toe `BoardState` class with `__init__` and `render` method
    cards compiles to a file where both methods appear inside `class
    BoardState:` with correct indentation.
  - `python -m py_compile <output>` succeeds.
  - `python -c "from output import BoardState; b = BoardState(); b.render()"`
    succeeds.
- **Blocks**: #21 (tic-tac-toe needs class support)
- **Files**: `src/code_compile.js`

---

## Phase 6 · Cell-as-sandbox loop, manual mode

### #15 Dependency graph + topological "next leaf" finder
- **Scope**: Implement `src/dep_graph.js`. Build a DAG from cards' `links`
  (which are @reference card titles). Expose:
  - `topologicalOrder(doc)` → array of cards, leaves first
  - `nextReadyCard(doc)` → first unfrozen card whose every upstream `@ref`
    is frozen (or null)
  - `cycle detection` → throw on cycles with a clear error
- **Acceptance**:
  - Unit test: tic-tac-toe doc → `topologicalOrder` returns leaves
    (`is_winning_line`, `valid_moves`, `apply_move`) before consumers
    (`check_winner`, `play_loop`).
  - Cycle (A→B→A) throws.
  - `nextReadyCard` skips cards with unfrozen upstream refs.
- **Blocks**: #16, #19
- **Files**: `src/dep_graph.js` (new), `tests/dep_graph.test.js` (new)

### #16 Per-card draft state (chat + candidateSource + iterationCount)
- **Scope**: When user sends a prompt for an unfrozen code card, append to
  `card.draft.chat` (rolling window of last 3 turns / 6 messages).
  Streaming response goes into `draft.candidateSource`. `iterationCount`
  bumps on each regenerate. Persist `draft` through JSON.
- **Acceptance**:
  - Chat 4 turns into a card → `draft.chat.length === 6` (last 3 turns).
  - Reload mid-iteration → draft state intact.
  - Sending only ever passes the rolling-window chat, not full history.
- **Blocks**: #17, #18, #19
- **Files**: `src/cards.js`, `src/ai_chat.js`

### #17 Freeze ceremony (`⌘⇧F`)
- **Scope**: Implement freeze handler:
  1. If `draft.candidateSource` empty → reject.
  2. If `prompt` unchanged from first chat message AND `iterationCount > 0`
     → modal asks user to distill first; user can override.
  3. Commit: `source := draft.candidateSource`, `prompt := <distilled>`,
     `metadata.iterations := draft.iterationCount`, `draft := null`,
     `frozen := true`.
  4. Re-render card in canonical (read-only source + prompt header) view.
- **Acceptance**:
  - Click freeze → card flips to canonical view; `draft` is null in JSON.
  - Re-edit ("unfreeze") → card flips back to draft view; `draft.chat`
    starts empty, `candidateSource` seeded with previous source.
- **Blocks**: #19, #20
- **Files**: `src/cards.js`, `src/main_script.js`

### #18 Distill: manual edit + `⌘D` auto-distill
- **Scope**: Distill modal shows draft chat side-by-side with editable
  `prompt` field. "Auto-distill" button calls AI: "rewrite this prompt to
  capture what the user actually meant given the chat." User reviews + can
  edit before commit. Records `metadata.distilledBy = 'manual' | 'auto'`.
  `⌘D` opens the modal directly.
- **Acceptance**:
  - Manual flow: user types a new prompt, clicks confirm → prompt updated
    on card, `distilledBy: 'manual'`.
  - Auto flow: `⌘D` → AI returns a distilled prompt, user accepts as-is →
    `distilledBy: 'auto'`.
  - Cancelling the modal does not modify the prompt.
- **Blocks**: #17 (freeze guard depends on this existing)
- **Files**: `src/main_script.js`, `src/ai_chat.js`

### #19 Iteration cap (3 default + extend by 5)
- **Scope**: After 3 regenerations on a single card, slate surfaces a
  banner: "AI has tried 3 times. Want to try 5 more, or write the function
  yourself?" Buttons: `[+5 more]` `[I'll write it]`. `[I'll write it]`
  switches the candidateSource to an editable textarea.
- **Acceptance**:
  - 4th regenerate → banner appears.
  - `+5 more` → cap raises to 8; banner reappears at attempt 8.
  - `I'll write it` → user-editable code editor for `candidateSource`.
- **Blocks**: nothing
- **Files**: `src/main_script.js`, `src/ai_chat.js`

### #20 Terminal hand-off (`⌘⇧R`)
- **Scope**: New VS Code extension command `slate.runInTerminal`. Slate
  webview posts a message with the assembled paste-block (header imports +
  frozen `@ref` sources + candidate source + tests). Extension calls
  `vscode.window.activeTerminal.sendText()` (creates a terminal if none
  exists). `⌘⇧R` shortcut wired in webview.
- **Acceptance**:
  - In VS Code with the extension loaded: open a card, hit `⌘⇧R` → the
    integrated terminal receives the paste-block with header + refs +
    candidate + tests.
  - In browser (no `acquireVsCodeApi`), `⌘⇧R` shows a "VS Code only"
    notice.
- **Blocks**: nothing critical
- **Files**: `src/terminal_handoff.js` (new), `src/host_bridge.js`,
  `vscode-extension/src/extension.ts`

---

## Phase 7 · Target/language registry

### #21 `project.targets[]` + `doc.targetId` + compile dispatcher
- **Scope**: Add `targets[]` to Project. Default Python target synthesized
  on load for legacy projects. `doc.targetId` references a target.
  `src/compile.js` dispatches by `target.language`. Move
  `code_compile.js` → `src/compilers/python.js`. Stub
  `src/compilers/{cpp,csharp,javascript}.js` that throw "not implemented in
  v0.2".
- **Acceptance**:
  - Old project loads, gets `targets: [{id: 'py-default', ...}]`, every doc
    `targetId === 'py-default'`.
  - Compile produces byte-identical output to phase 4 (no behavioral
    change yet).
  - Selecting `cpp` language on a card → compile throws clear error.
- **Blocks**: #22
- **Files**: `src/project.js`, `src/doc.js`, `src/compile.js` (new),
  `src/compilers/index.js` (new), `src/compilers/python.js` (moved),
  `src/compilers/{cpp,csharp,javascript}.js` (new stubs)

### #22 `.slate-map.json` write
- **Scope**: After every successful compile, write/update
  `<workspaceRoot>/<target.sourceRoot>/.slate-map.json` with the entry for
  the produced file (docId, projectId, compiledAt, cardIds, sourceHash =
  sha256 of source). v0.2 writes; v0.3 reads.
- **Acceptance**:
  - Compile a doc → file exists at expected path AND `.slate-map.json`
    contains its entry.
  - Recompile → entry's `compiledAt` and `sourceHash` update; other entries
    untouched.
- **Blocks**: nothing in v0.2 (read path is v0.3)
- **Files**: `vscode-extension/src/extension.ts` (write happens host-side)

---

## Phase 8 · Prompt-bar UI overhaul + shortcuts

### #23 Language dropdown replaces "Code" toggle
- **Scope**: Replace the boolean code toggle with a dropdown:
  `markdown | python | (cpp/csharp/javascript disabled)`. Selecting
  non-markdown auto-routes to the local provider.
- **Acceptance**:
  - Dropdown visible in prompt bar (in VS Code; hidden in browser per #29).
  - Switching to `python` flips the next card to `language: 'python', kind:
    'body'` and routes to local model.
- **Blocks**: #24
- **Files**: `src/main_script.js`, `src/index.html`

### #24 Model dropdown filtered by language
- **Scope**: Model dropdown next to language dropdown. For markdown, lists
  cloud agents (OpenAI/Gemini) the user has keys for. For code languages,
  lists configured local Ollama models + cloud agents marked
  "code-capable" in settings.
- **Acceptance**:
  - Switching language updates model options.
  - Choosing a model overrides the per-language default for the next send.
- **Blocks**: nothing
- **Files**: `src/main_script.js`, `src/ai_utils.js`

### #25 ADD TO DOC as single primary action
- **Scope**: Remove standalone SEND button. ADD TO DOC sends → streams
  response → on stream complete, commits to current card's draft. (Freeze
  is a separate action, `⌘⇧F` per #17.)
- **Acceptance**:
  - One primary button visible. Streaming response renders in prompt area.
  - On stream complete, draft is updated; user can iterate or freeze.
- **Blocks**: nothing
- **Files**: `src/main_script.js`, `src/index.html`

### #26 Wire all `⌘`-shortcuts from §4.1
- **Scope**: Implement keyboard handlers for `⌘↵`, `⌘.`, `Esc`, `⌘K`
  (command palette), `⌘E` (extract imports), `⌘⇧R`, `⌘⇧F`, `⌘G`, `⌘D`.
  Document in a `?` overlay accessible from the UI.
- **Acceptance**:
  - Each shortcut triggers its action with the focused card as target.
  - `⌘K` opens a command palette listing all actions with their shortcuts.
  - `?` shows an overlay with the full table.
- **Blocks**: nothing
- **Files**: `src/main_script.js`, `src/styles.css`

### #27 Bibliography preview before SEND
- **Scope**: Above the prompt textarea, show a collapsible "Context that
  will be sent" panel listing: system prompt name, header card source,
  each direct `@ref` card's source, last N draft turns. Token estimate per
  item. Updates live as user types `@refs`.
- **Acceptance**:
  - Typing `@foo` adds foo's source to the preview with its token count.
  - Total token count visible at the bottom; turns red when over budget.
  - Pre-send refusal (#6) references this preview.
- **Blocks**: nothing
- **Files**: `src/main_script.js`, `src/ai_chat.js`

---

## Phase 9 · Tic-tac-toe example + CI

### #28 Ship `examples/tic_tac_toe.slate.json`
- **Scope**: Hand-craft the JSON for the doc structured per spec §7
  (header card, `BoardState` class with two methods, free functions
  `is_winning_line`, `check_winner`, `valid_moves`, `apply_move`,
  `ai_player_random`, `play_loop`). Each card has `tests` (1-3 each).
  All cards `frozen: true` with realistic distilled prompts.
- **Acceptance**:
  - Loading the example into slate produces the expected card hierarchy.
  - `node scripts/compile-example.js examples/tic_tac_toe.slate.json
    --out /tmp/tic_tac_toe.py` succeeds.
- **Blocks**: #29, #30
- **Files**: `examples/tic_tac_toe.slate.json` (new),
  `scripts/compile-example.js` (new)

### #29 vitest setup + compiler/migration unit tests
- **Scope**: Add `vitest` to devDependencies. Wire `npm test`. Initial
  test files: `tests/compiler.test.js` (Python compiler emits expected
  output for known inputs), `tests/migrations.test.js` (cardType→language,
  content→source, header synthesis), `tests/dep_graph.test.js` (extends
  #15). No browser tests yet.
- **Acceptance**:
  - `npm test` runs and passes locally.
  - 100% of migration shims have at least one test exercising them.
- **Blocks**: #30
- **Files**: `tests/` (new), `package.json` (devDependencies + script)

### #30 CI workflow gating release
- **Scope**: GitHub Actions (or equivalent) workflow:
  1. `npm ci`
  2. `npm test`
  3. `npm run build`
  4. `node scripts/compile-example.js examples/tic_tac_toe.slate.json
     --out /tmp/tic_tac_toe.py`
  5. `python -m pytest /tmp/tic_tac_toe.py`
  6. `python /tmp/tic_tac_toe.py` (smoke run; expect non-zero exit only on
     genuine failure)
- **Acceptance**:
  - PR fails CI if any step fails.
  - Main branch is always green.
- **Blocks**: nothing
- **Files**: `.github/workflows/ci.yml` (new)

---

## Phase 10 · Hosting freeze (reframed 2026-05-09 — see spec §3)

### #31 `isCodeHost()` gates only host-specific bits
- **Scope** *(reduced)*: Confirm `host_bridge.js#isCodeHost()` returns true
  iff `window.acquireVsCodeApi` is defined. Gate **only** the truly
  host-specific UI: terminal hand-off button (`⌘⇧R`), "compile to
  workspace" path, `.slate-map.json` write, `.slate.json` custom editor
  registration. Everything else (language dropdown, model dropdown, code
  cards, compile-to-download, draft/freeze, dep graph, token budget,
  system prompts) renders unconditionally on both surfaces.
- **Acceptance**:
  - GH Pages web build shows the full LLM harness; "compile" button
    triggers a browser download instead of a workspace write.
  - VS Code extension shows the same UI plus a terminal-handoff button
    and routes "compile" to a workspace write.
  - No regression in either surface.
- **Blocks**: #32
- **Files**: `src/host_bridge.js`, `src/main_script.js`,
  `src/terminal_handoff.js` (created by #20)

### #32 README + install copy update
- **Scope**: Update `README.md` to describe slate as **one harness, two
  surfaces** (per spec §3). Web install: just visit the GH Pages URL.
  VS Code install: download the VSIX or marketplace link. Drop all
  references to `slate-notebook.com` and the "two products" framing.
- **Acceptance**:
  - README has a "One harness, two surfaces" section pointing to both.
  - VS Code install instructions are present and tested.
  - No `slate-notebook.com` references remain in docs.
- **Blocks**: nothing
- **Files**: `README.md`, `vscode-extension/README.md`,
  `slate-code-v0.2-spec.md` (already updated)

---

## Phase 11 · Web deployment + decoupling (new — added 2026-05-09)

*All phase 11 issues shipped — see [features.md](features.md#phase-11--web-deployment--decoupling).*

---

## Phase 0 · Architecture & modularity (new — added 2026-05-10)

> Cross-cutting refactor work tracked against the roadmap in
> [ARCHITECTURE.md](ARCHITECTURE.md#refactor-roadmap). Phase A foundations
> already shipped (capabilities matrix, map, event bus). Issues below cover
> the remaining phases B → D. Each is one shippable PR.

### #47 Phase D · Preset schemas + compiler registry
- **Scope**: Land the preset system from
  [ARCHITECTURE.md § Phase D](ARCHITECTURE.md#phase-d--presets--compiler-registry).
  `src/preset_schemas/{markdown,python}.js` bundle
  `{ language, systemPrompt, cardSchema, compiler, bibliographyAssembler,
  shortcuts, budget }`. `src/compilers/index.js` becomes the registry;
  `code_compile.js` moves to `compilers/python.js`. `chat_ctl` and
  `compile_ctl` look up the active preset by `card.language`.
- **Acceptance**:
  - Adding a placeholder C# preset is exactly: 1 file in
    `preset_schemas/` + 1 file in `compilers/` + 1 line in
    `caps.languages` for vscode.
  - No controller or applet hard-codes a language name.
- **Blocks**: nothing in v0.2; unblocks v0.3 multi-language work
- **Files**: `src/preset_schemas/{markdown,python}.js` (new),
  `src/compilers/index.js` (new), `src/compilers/python.js` (moved from
  `src/code_compile.js`), `src/controllers/{chat,compile}_ctl.js`

---

## Phase 12 · Editor + UI polish (new — added 2026-05-09)

### #40 VS-Code-like editors — phase B (preview toggle + scroll polish)
- **Status**: **Phase A shipped** (see [features.md](features.md) — real
  monad-themed syntax highlighting in prompt + response + rendered cards;
  language switching wired). Phase B is the remaining polish.
- **Scope (phase B)**:
  - Markdown response cards default to **source view** (already shipped)
    but add a `[👁 preview]` toggle that swaps to a rendered-markdown
    view (using `marked.parse`, same as a saved card's display) so users
    can see the formatted output without committing.
  - Audit the response editor's wrap + scroll behavior in tall code
    cards (>30 lines): make sure horizontal scroll appears for long
    lines and vertical scroll for the editor (not the page).
  - Optional: line numbers for code cards only (not for markdown).
  - Optional: consider whether the response editor should auto-resize
    to content vs. fixed height with internal scroll.
- **Acceptance**:
  - Toggle button on markdown response cards swaps source ↔ preview
    cleanly.
  - Code response with 100 lines: editor scrolls internally; page
    layout doesn't shift.
- **Blocks**: nothing
- **Files**: `src/ai_chat.js`, `src/styles.css`, possibly
  `src/codemirror_setup.js` (line numbers extension)

### #48 Compile overwrite confirmation in Slate's modal (not the macOS native dialog)
- **Scope**: Today, hitting COMPILE in the VS Code surface for a doc whose
  `.py` already exists fires a native macOS "modal" warning via
  `vscode.window.showWarningMessage(..., { modal: true }, 'Overwrite')`
  inside `writeCompiledFile()` in
  [vscode-extension/src/extension.ts](vscode-extension/src/extension.ts).
  We want that confirmation to happen inside Slate's own [Modal](src/modal.js)
  ("Overwrite `<dest>/<file>.py`?" with Confirm/Cancel) so the experience
  matches the rest of the app and works the same way on every OS.
- **Approach (sketch — finalize in PR)**:
  - Webview side: add `compile:needs-confirm` and `compile:confirmed`
    event-bus contract in [src/controllers/compile_ctl.js](src/controllers/compile_ctl.js).
  - Host side: when the target file exists, `writeCompiledFile` posts
    `{ type: 'compile-needs-confirm', filename, destination }` back to the
    webview instead of calling `showWarningMessage`. Slate's modal shows
    the confirm dialog. On confirm, webview posts
    `{ type: 'compile-confirm', filename, destination, source }` and the
    host writes unconditionally.
  - Browser surface is unaffected — the `<a download>` flow has no
    pre-existing-file concept.
- **Acceptance**:
  - Compiling an existing `.py` in VS Code shows Slate's modal, not the
    native dialog.
  - Cancel cleanly aborts the write.
  - First compile (file doesn't exist yet) skips the prompt entirely, as
    today.
  - The host still rejects unsafe filenames (`path.basename` mismatch,
    `..`, etc.) before any prompt happens.
- **Blocks**: nothing
- **Files**: [vscode-extension/src/extension.ts](vscode-extension/src/extension.ts),
  [src/controllers/compile_ctl.js](src/controllers/compile_ctl.js),
  [src/main_script.js](src/main_script.js) (modal subscriber)

### #41 Build-flag test split (lite vs full)
- **Scope**: Forward-looking note from the user: the test strategy can
  follow the build flag — `web` (lite, no Python) runs UI / data-model /
  compiler-emit tests; `vscode` (full, with Python) additionally runs
  `python -m pytest` on compiled outputs. Wire this into CI so the right
  tests run for the right surface, and so contributors without Python
  installed can still run the lite suite.
- **Acceptance**:
  - `npm test` (lite) runs without Python, exercises the JS data model
    and compiler emit.
  - `npm run test:full` runs lite + the Python pytest pass over compiled
    examples.
  - CI runs lite always; full only when Python is available in the
    runner (always true on GH Actions ubuntu-latest).
- **Blocks**: #29 (vitest setup) is the prerequisite
- **Files**: `package.json`, `.github/workflows/ci.yml` (created by #30)

---

## Cross-cutting (anytime)

### #33 Decide: token estimator — heuristic vs `js-tiktoken`
- **Scope**: Decision + implementation. char/3.5 is wildly imprecise for
  code. Pull in `js-tiktoken` (~50KB) for accurate counts, or stay
  heuristic and tune the budget headroom?
- **Acceptance**:
  - Decision documented in `slate-code-v0.2-spec.md` §6.5 (replaces the
    "open question").
  - If `js-tiktoken`: dependency added, `token_budget.js` uses it.
- **Blocks**: tighter #6 budgets
- **Files**: `src/token_budget.js`, `package.json`

### #34 Decide: test format — `snippet` only, `io` only, or both
- **Scope**: Decision documented + implementation matches. Spec §5
  currently lists both shapes; pick one for v0.2.
- **Acceptance**:
  - Decision in spec.
  - tic-tac-toe example uses only the chosen format.
- **Blocks**: #28
- **Files**: spec doc, `examples/tic_tac_toe.slate.json`

### #35 Decide: VS Code extension publish target
- **Scope**: Marketplace from day one, or VSIX sideload only until
  tic-tac-toe CI is green?
- **Acceptance**:
  - Decision documented.
  - If marketplace: publisher account set up, publish workflow added.
- **Blocks**: nothing pre-release
- **Files**: spec doc, possibly `.github/workflows/publish.yml`

### #36 Decide: class nesting depth — one level only or arbitrary
- **Scope**: v0.2 spec says one level (class → methods). Locked in or
  reconsider for nested classes / inner functions?
- **Acceptance**:
  - Decision in spec.
  - Compiler enforces it (rejects deeper nesting with a clear error).
- **Blocks**: #14
- **Files**: spec doc, `src/code_compile.js`

### #52 Phase E · Port the project graph from d3 to Cytoscape.js
- **Scope**: `src/network_viz.js` (562 LOC of mixed concerns) is the
  weakest part of the architecture map and the only place where
  zoom-to-fit / camera-follow / layout tweaks felt genuinely awkward.
  Cytoscape gives us native `cy.fit()`, `cy.center(node)`, `cy.layout(...)`
  with dagre/grid/cola presets, declarative styling, and built-in
  graph-algorithm helpers (handy for #15 DAG topo). Migration is cheap
  because `Project.toGraphData()` already returns library-agnostic
  `{ nodes, links }` shape — only the renderer changes.
- **Acceptance**:
  - `src/network_viz.js` replaced by a Cytoscape-backed module of the
    same surface (`new NetworkViz(...)`, `updateData(graph)`,
    `resetZoom()`, `zoomToFit()`, `zoomToNode(id)`).
  - Existing callers (main_script.js + ai_chat.js loadCardForEdit hop)
    keep working without changes.
  - d3 dependency removed from package.json (or kept only if other
    code still uses it — currently only viz does).
  - Bundle size doesn't grow (Cytoscape core is comparable to d3-force).
- **Files**: `src/network_viz.js` (rewrite), `package.json`,
  `ARCHITECTURE.md` hotspots table.
- **Notes**: Discussed in the d3-alternatives table from
  [features.md](features.md#viz-zoom-to-fit-by-default--camera-follow-on-card-edit).
  Cytoscape was the recommended target for long-term graph-algo work.

*#53 (round-trip code edits from .py back into cards) shipped 2026-05-10
— see [features.md](features.md#53-phase-e--round-trip-code-edits-from-py-back-into-cards).*

### #55 Phase E · Stub-first workflow (prompt-only / "stub" cards as first-class)
- **Scope**: Today every card has to materialize content the moment it's
  added — there's no "I'll come back and fill this" state. The user's
  natural workflow (and most pre-AI codebases) is the opposite: scaffold
  empty function stubs with intent comments first, then come back and
  fill them. The "AI gamble" loop ("type prompt → boom, code") skips
  scaffolding entirely, which makes the resulting graph sprawling and
  hard to reason about.
- **Proposed surface**:
  - **Stub cards**: a card with `content === ''` but a non-empty
    `prompt` is already a first-class state in our data model
    (it's what GENERATE ALL picks up). Promote it visually:
    "stub" pill in the card UI, distinct chrome (dashed border?), and a
    single-click "fill stub" button that runs the stub's prompt + any
    @-refs through the active model.
  - **Stub-from-signature**: support typing a Python signature into the
    prompt (e.g. `def add(a: float, b: float) -> float`) and have Slate
    create a stub card with the signature pre-filled in `content` and
    the prompt body kept as the natural-language intent. Compile-time
    placeholder body is `raise NotImplementedError(prompt)` so the
    file imports cleanly and pytest fails loudly on "not yet filled".
  - **One-shot scaffold**: from a doc header card, generate N stubs at
    once based on a "design" prompt (e.g. "I need read_input,
    apply_op, format_result, and main"). Each becomes a stub card the
    user can review before running fill.
  - **Issues-as-stubs convention**: every new TODO becomes a stub card
    with the comment as the prompt — direct mapping from
    [issues.md](issues.md) entry → card. Manual today; Slate could
    surface a "create stub from selected text" action.
- **Acceptance**:
  - Empty-content cards render with a visible "stub" affordance + a
    one-click "fill" button.
  - "Add stub from signature" flow: paste a `def`/`class` line + intent;
    creates a stub card whose content is the signature with a
    `raise NotImplementedError(...)` body referencing the prompt.
  - Compiled `.py` from a doc with stubs is importable; calling a stub
    function raises `NotImplementedError`. pytest fails predictably.
  - GENERATE ALL still finds and fills these stubs (already works since
    the data model is identical).
- **Blocks**: nothing immediately; pairs well with #56 (load codebase)
  because imported functions whose body is empty / single-line / docstring-
  only could be auto-classified as stubs.
- **Files**: `src/applets/card_view/code_card.js` (stub chrome),
  new `src/applets/stub_actions/` (signature parser + scaffold-N action),
  `src/code_compile.js` (NotImplementedError placeholder body),
  possibly `src/cards.js` (a derived `isStub()` helper).
- **Notes**:
  - User's framing: "the cycle of fill-up-stub is good cause it keeps
    the codebase limited and all new issues become a new stub with a
    comment attached to it that has to be done."
  - This is the missing pre-AI half of the workflow. AI handles
    "generate from intent"; stubs handle "remember to come back."

### #56 Phase E · Load codebase: scan a folder of `.py` files into a Slate project
- **Scope**: The user keeps switching back to plain VS Code first
  because Slate can't ingest existing codebases — it's strictly a
  "start a new project" tool. Goal: point Slate at a folder
  (e.g. [/Users/r2d2/Desktop/gandiva](file:///Users/r2d2/Desktop/gandiva))
  and get a Slate project where every Python file becomes a doc and every
  top-level def/class becomes a card, with the AI auto-generating
  prompt-style "explanation" text per imported function as a starting
  point for the round-trip loop.
- **Existing groundwork** (do not rebuild):
  - [vscode-extension/src/python_scan.ts](vscode-extension/src/python_scan.ts)
    already does workspace scanning + block extraction + import
    extraction (~285 LOC) and is wired to `slate.scanWorkspace`.
  - The round-trip work shipped under #53 already proves
    file-on-disk ↔ slate-card mapping is bidirectional and
    fixed-point.
- **Proposed surface**:
  - "Open folder as Slate project" command in the VS Code extension.
  - Each `.py` → one doc; doc title = file stem; each top-level
    `def`/`class` → one body card; module-level imports + constants →
    header card.
  - Optional second pass: AI-generated prompt per body card describing
    what the function does (single-line summary + "args/returns" tail).
    User can opt in / opt out.
  - Cross-file imports become @-references on the destination card,
    auto-linking the project graph (testing #15 / #52 at scale).
- **Acceptance**:
  - Pointing slate at a small real repo (gandiva, or one of the
    examples in this repo's `examples/` dir treated as a "found"
    folder) produces a project where:
    - Every file is a doc; every top-level def is a card.
    - Imports across files become @-refs in the project graph.
    - Round-trip (compile every doc back out to `.py`) is
      byte-identical for files that were already annotation-free
      (legacy path); annotated on next compile.
  - User-facing: a single "import folder" button in the VS Code
    extension that triggers the scan and seeds the project.
  - Headless: `npm run slate:import-folder -- <path>` produces a
    `.slate.json` for any python folder, suitable for CI.
- **Blocks**: nothing; unblocks "use Slate on real existing codebases"
  which is the only path to user growth beyond "fresh project" demos.
- **Files**: extend `vscode-extension/src/python_scan.ts`
  (already substantial), new `scripts/slate_import_folder.js`,
  reuse `src/code_compile.js` + `src/slate_annotations.js` from #53.
- **Notes**:
  - Pairs naturally with #55 — imported functions whose body is
    `pass` / `...` / docstring-only become stubs automatically.
  - Pairs naturally with #57 — once a project is loaded, the user
    almost certainly wants to operate on a subgraph (just the auth
    module, just the data layer), not the entire project.
  - User context: "I keep switching from slate to code first... we
    need to be able to load back in code and projects."

### #57 Phase E · DAG-scoped subgraph operations (post-Cytoscape #52)
- **Scope**: Today GENERATE ALL and COMPILE ALL operate on the full
  project. On a real codebase (#56), that's almost never what the
  user wants — they want to operate on the subgraph reachable from
  one node (or a small handful of selected nodes). Once Cytoscape
  ships (#52), Slate has the graph-algorithm primitives needed to
  do this naturally.
- **Proposed surface**:
  - Click a node in the project graph → "operate on this subgraph"
    options light up: GENERATE SUBGRAPH, COMPILE SUBGRAPH, AUDIT
    SUBGRAPH.
  - "Subgraph" = the set of cards reachable from the selected node
    via @-references (transitive closure). Direction matters —
    leaves first, root last (matches the existing #15 topological
    order and the user's "from leaves to main()" mental model).
  - Multi-select: shift-click multiple nodes → union of their
    subgraphs. Useful for "generate the auth module + the data
    layer but leave the UI alone."
  - Visual feedback: dim cards outside the active subgraph in the
    graph viz so the user sees exactly what's in scope.
- **Acceptance**:
  - From the network panel, selecting a card and clicking GENERATE
    SUBGRAPH walks only the cards reachable through @-refs from the
    selection, in #15 topological order (leaves first).
  - Same for COMPILE SUBGRAPH (only writes the `.py` files for docs
    in scope).
  - Empty-content cards in the subgraph get filled; cards outside
    the subgraph are left untouched.
  - Multi-select works; out-of-scope cards are visually dimmed.
- **Blocks**: depends on #15 (topo order) + #52 (Cytoscape) shipping
  first. Doesn't block anything downstream.
- **Files**: `src/network_viz.*` (selection + dimming),
  `src/controllers/compile_ctl.js` (`compileProject` →
  `compileSubgraph(rootIds)`), `src/main_script.js` (walkthrough
  scope from "all" to "subgraph").
- **Notes**:
  - User context: "DAG logic the way I explained it is reversed —
    we start at the leaves and work our way back to the main()
    function" — confirmed; #15's existing
    `topologicalOrder returns leaves before consumers` test already
    locks in that direction.
  - Most large-codebase workflows are subgraph-scoped — full-graph
    operations only make sense on small projects (calculator,
    tic-tac-toe).

### #54 Phase 0 · Migrate `src/` from JS to TypeScript
- **Scope**: Slate's main `src/` tree is vanilla ES6+ JS (no types, no
  linter, no formatter — see [CLAUDE.md](CLAUDE.md)). The VS Code
  extension at [vscode-extension/](vscode-extension/) is already TS.
  Slate has reached the size where the lack of type checks is starting
  to cost real time:
  - Round-trip work (#53) involved 6+ files coordinating on the same
    `Card` / `Doc` / `Project` shape and on a fragile `section` object
    contract from [src/slate_annotations.js](src/slate_annotations.js);
    a typo in any of those would silently propagate.
  - Card kind / cardType / language fields drift across files
    (header / body / class · code / markdown · python / markdown).
  - The applets registry contract (`mount(deps) → { destroy }`) is
    enforced by convention, not by the compiler.
  - Future #47 preset registry will introduce a 4-field schema
    (`{ language, systemPrompt, cardSchema, compiler, ... }`) that's
    asking to be a TS type.
  - "Slate develops slate" requires the AI to make surgical changes.
    A type system is the single biggest map-quality boost we could
    give the agent.
- **Approach (sketch — refine in PR)**:
  - Add `tsconfig.json` at repo root with `allowJs: true`,
    `checkJs: false`, `noEmit: true`. Vite already supports TS in
    `src/` — no bundler change needed.
  - Phase migrate, leaf-first (low-coupling files), one or two PRs at a
    time. Suggested order:
    1. **Pure data + helpers** (no DOM): `slate_annotations.ts`,
       `rehydrate.ts`, `code_compile.ts`, `python_parser.ts`,
       `token_budget.ts`, `capabilities.ts`, `event_bus.ts`,
       `host_bridge.ts`. ~10 files.
    2. **Models**: `cards.ts`, `doc.ts`, `project.ts`. Define the
       canonical `CardKind`, `CardType`, `Language` union types here.
    3. **Controllers**: `controllers/*.ts`. Define `Ctx` interfaces
       per controller's `init...Ctl(ctx)` injection.
    4. **Applets**: `applets/**/*.ts`. Lock the
       `mount(deps) → { destroy }` contract via a shared `Applet<T>`
       interface.
    5. **Last**: `main_script.ts`, `ai_chat.ts`, the view layer.
  - Each PR keeps the build + tests green; nothing is renamed in mass.
  - Pull `eslint` + `@typescript-eslint` in once the leaf files are
    typed so we get type-aware lint without a Day-1 megabang.
- **Acceptance**:
  - `npm run typecheck` (new script wrapping `tsc --noEmit`) is green.
  - `npm test` keeps passing throughout migration.
  - Vite production build size doesn't regress (TS is erased; the
    output JS should be the same byte count modulo helpers).
  - At least the leaf files (annotations, rehydrate, compile, parser,
    capabilities, event bus, host bridge) compile under
    `strict: true`.
  - VS Code extension's TypeScript pulls types from `src/` instead of
    string-typed message payloads where practical.
- **Blocks**: nothing immediately; unblocks safer #47 preset registry,
  cleaner #21 target/language registry, and gives the AI a real map
  for "slate develops slate" iteration.
- **Files**: new `tsconfig.json`, every `src/**/*.js` (rename + type
  annotation), `package.json` (add `typescript`, `npm run typecheck`),
  `ARCHITECTURE.md` (note the language).
- **Notes**:
  - The user's stated rationale: "I think something like Slate
    benefits from having type checks and stuff" — JS got us to MVP,
    TS gets us to v1.
  - Single-file migrations are the easiest to review; resist the urge
    to do a megacommit.
  - The pure helpers we just shipped (annotations, rehydrate) are the
    natural starting wedge — small, headless, well-tested, no DOM.

---

## Tracking

- **Open**: every issue above. **37 of 57 open** (phase 1 shipped: #1–#4;
  phase 11 shipped: #37–#39; phase 12 partial: autocomplete/font polish +
  #40 phase A; phase 0 shipped so far: A foundations + #42 compile_ctl +
  #43 chat_ctl + #44 doc/project/card controllers + #51 drop SUMMARY +
  #49 auto-header-context + #50 two-part response schema + #45 Phase C-a
  prompt_bar applet + Phase C-b card_view applets + #46 Phase C-c
  capability-gated applets (feedback_widget / terminal_handoff /
  landing_tour); phase E shipped: #53 round-trip code edits + the
  companion VS Code annotation-grammar highlighter (supersedes #11 +
  #12) — see [features.md](features.md); #48 still open — compile-
  overwrite modal in slate, not native macOS dialog).
- **Workflow**: when an issue ships, cut+paste its block into
  [features.md](features.md) and append a `**Resolved:** YYYY-MM-DD —
  <commit-or-PR>` line at the bottom of the block. Do **not** leave shipped
  issues here; this file is always "what's left."
- **Dependencies**: respect `Blocks` lines. The phase order in the spec is
  the safe path; cross-phase parallelism is fine if the dependency chain
  allows it.

---

*Related: [slate-code-v0.2-spec.md](slate-code-v0.2-spec.md) ·
[features.md](features.md) · [slate-code-plan.md](slate-code-plan.md)*
