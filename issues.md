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

### #4 Forbid duplicate header cards & enforce position 0
- **Scope**: `addCard()` rejects a second `kind: 'header'` card per doc.
  Header card always sorts to index 0; cannot be moved.
- **Acceptance**:
  - Adding a second header card returns false + logs a warning.
  - Moving a body card to index 0 still leaves the header at 0 (header is pinned).
- **Blocks**: nothing critical
- **Files**: `src/doc.js`

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

### #11 Compiler emits `# @slate:` annotations
- **Scope**: Python compiler (still `code_compile.js` at this point)
  emits per-card header block: `# @slate: card=<title> doc=<title> frozen=<bool>`,
  `# @slate-meta: model=... generated_at=... iterations=N`, and
  `# @slate-prompt: |` + indented prompt lines. Reserve `# @slate*` namespace:
  collisions in card source escaped to `# (was-@slate)`.
- **Acceptance**:
  - Compile a doc with one frozen + one unfrozen code card: output has the
    annotation block above each function.
  - A card whose source contains `# @slate: foo` produces output with
    `# (was-@slate): foo`.
- **Blocks**: #12 (header card prepend), v0.3 `.py` import
- **Files**: `src/code_compile.js`

### #12 Compiler prepends header card source
- **Scope**: After the file banner, before extracted imports, emit the
  header card's source verbatim (with a `# === slate header ===` separator
  comment). Header card is not part of the topological body card list.
- **Acceptance**:
  - Doc with header `import numpy as np` and one body card using `np.array`
    compiles to a file where `import numpy as np` appears above the
    function.
  - `python -m py_compile <output>` succeeds.
- **Blocks**: nothing critical
- **Files**: `src/code_compile.js`

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

## Phase 10 · Hosting freeze

### #31 `isCodeHost()` gates code-mode UI
- **Scope**: Add `isCodeHost()` to `src/host_bridge.js` returning true iff
  `window.acquireVsCodeApi` is defined. Gate language dropdown (beyond
  markdown), model dropdown, compile button, terminal hand-off button,
  and class-nesting UI behind it.
- **Acceptance**:
  - `npm run dev` (browser) shows zero code-mode UI; markdown notebook
    flow is identical to v0.1.
  - VS Code extension loaded → all code-mode UI visible.
- **Blocks**: #32
- **Files**: `src/host_bridge.js`, `src/main_script.js`

### #32 README + landing copy update
- **Scope**: Update `README.md` to describe the two products clearly:
  browser = markdown notebook (slate-notebook.com), VS Code extension =
  code harness. Update `vscode-extension/README.md`. Update
  slate-notebook.com landing copy if applicable.
- **Acceptance**:
  - README has a "Two surfaces" section explaining the split.
  - Install instructions for the VS Code extension are present and tested.
- **Blocks**: nothing (release-blocking only)
- **Files**: `README.md`, `vscode-extension/README.md`

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

---

## Tracking

- **Open**: every issue above. As of v0.2 spec finalization, **all 36
  issues are open**.
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
