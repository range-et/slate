# Slate build plan — agent handoff

The implementation playbook for whoever builds the next phase (human or
agent). [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md) says *what and why*,
[GitHub Issues](https://github.com/range-et/slate/issues) lists tasks with acceptance criteria, and
[features.md](features.md) is the shipped inventory. This file says *how*: the
code map, conventions, verification recipe, learnings, and a step-by-step
design per phase.

## How to run a phase

1. **One thread per phase.** Context size is the main cost driver. Start
   fresh, read this file, the phase's issues, and only the files listed for
   that phase. `harness_panel.ts` is large, so read targeted line ranges.
2. **Build in slices.** Commit locally after each green slice. Never push,
   publish, or deploy without the owner's explicit approval.
3. **Verify** with the recipe below. Every UI change needs a rendered
   screenshot inspected with `view_media`.
4. **Close the phase:** complete and verify the GitHub issues, record shipped
   behavior in `features.md` with issue/PR links and validation evidence, update
   this file's design if needed, append a **Phase log** entry, and commit. Close
   issues when their acceptance criteria are met and the work is merged.

## Owner intent (keep this front of mind)

- **Core mental model ("Grasshopper where you forge the atomic components as you
  build the software"):** One large canvas where you compose nodes freely and
  wires mean dataflow.
  - **Atomic Library Units (`slate/nodes/**/*.json`):** The per-project
    component library — the *only* place where raw code (or atomic
    text-transform operators in Prose mode) lives. Strictly bounded by
    **JPL-60** (relaxed NASA JPL Rule of 10: `≤60` lines per function node,
    explicit parameter/return type annotations, bounded control flow, `Pydantic`
    contract validation, `pytest` checks, and `mutmut` mutation testing). Once
    verified, atomic units live in the project's Node Library as reusable
    building blocks.
  - **Compositions / Flows (`slate/flows/**/*.json`):** Everything above the
    60-line atomic level is a Flow — a wired graph of atomic library instances
    that compiles deterministically (`flowToNode`) without any LLM writing glue
    code.
- **Two-tier AI division of labor (strict architectural boundary replacing the
  blanket "no cloud anywhere" rule):**
  - **Tier 1 — Frontier Architect (via the Slate MCP Server, zero function
    bodies):** Connects any frontier model (Claude, Gemini, Antigravity) to the
    live Slate workspace to co-architect with the user: create/search spatial
    notes (`slate_find`, `slate_place_notes`), control the live canvas camera
    (`slate_focus` to pan/zoom to features/notes under discussion), define typed
    atomic stubs + contracts + test cases (`slate_define_stub`, refusing
    arbitrary body code), wire flows (`slate_wire_flow`), and split oversized
    (`>60`-line) nodes into smaller stubs.
  - **Tier 2 — Local LLM Component Forge (`llama.cpp`):** Takes a single forge
    input micro-packet (`≤600` tokens total across the target atomic stub's
    signature/intent/contract, selected cases, any bounded retry feedback, and
    bounded neighbor signatures + intents; trimming neighbor context first and
    refusing oversized targets whose stub + cases + retry feedback alone exceed
    `600` tokens) and generates/debugs the `≤60`-line function body + its unit
    check, verified by `Pydantic` + `pytest` + `mutmut`.
- The source of truth is a `slate/` folder of JSON only: one file per node,
  plus JSONs that refer to nodes by ID. Compile generates `src/`. The format
  stays language-agnostic (Python first, then Prose Mode `language: "prose"` as
  "ComfyUI for text" for grants and research, with TypeScript self-hosting and
  C# later through adapters).
- Porting existing projects is a first-class goal: split into node JSON
  mechanically, then describe each node with the local model one function at
  a time.
- The owner dislikes friction: hidden side effects on click, keystroke
  hijacking, modal command grammars, and anything that makes the canvas fight
  back.

## Code map (as of 2026-10-13)

| Area | File | Notes |
| --- | --- | --- |
| Folder format (pure) | `vscode-extension/src/slate_folder.ts` | parse/serialize slate.json, layout.json, node JSON (`uses`, `order`, `kind`); `indexNode`, `checkNodeCode`, `nodeFromSignature` |
| Folder IO (VS Code) | `vscode-extension/src/slate_folder_host.ts` | index folder, `readNodes`, read/write nodes (WorkspaceEdit + save), layout (fs write), create node |
| Panel / webview host | `vscode-extension/src/harness_panel.ts` | ~900 lines, folder only; `handleCanvasAction` (refs, placeholders, flows, wires) then `handleFolderAction` (node edits, compile, describe) |
| Python parsing | `vscode-extension/src/python_adapter.ts` | Lezer; `parseModule(source, path, nodeId?)`; `replaceUnit`; `splitImport`, `identifierNames`, `topLevelBindings` |
| Port / describe | `vscode-extension/src/port/python_importer.ts`, `port/describe.ts` | pure; importer `portPythonProject(files)`; describe order/packet/parse/loop |
| Compile | `vscode-extension/src/compile/python.ts` | pure `compilePython(nodes, config, flows?, library?)` → files + diagnostics; `flowToNode` codegen |
| Port/compile host | `vscode-extension/src/port_compile_host.ts` | `portPythonFolder`, `compileSlateFolder` (nodes + flows + library), the `Slate` output channel |
| Flows (pure) | `vscode-extension/src/flow.ts` | flow JSON, signatures → ports, endpoints, connect/extract; shared with the webview |
| Protocol types | `vscode-extension/src/harness_protocol.ts` | shared host ↔ webview types (webview re-exports them) |
| Generation | `vscode-extension/src/generation.ts`, `llama_transport.ts` | packet builder (uses `annotation.intent/contract/dependencies/locked`), SSE transport (optional `system`) |
| Search | `vscode-extension/src/search.ts` | ranks units over documents + `sources` |
| Extension entry | `vscode-extension/src/extension.ts` | commands (open, new, port, compile), custom editor (`**/slate/slate.json` only), launcher view, test-only commands |
| Webview app | `src/harness/main.tsx` | React + XYFlow; Inspector, menus, command UI |
| Graph building | `src/harness/graph.ts` | `buildGraph(snapshot, scope)` → root Compose, Map, or one flow; `callables`, `typeColor` |
| Demo snapshot | `src/harness/demo.ts` | `?demo` (any value) loads it; Playwright uses it |
| Gate scripts | `scripts/port-compile.js`, `scripts/compile-slate.js` | port + compile a Python folder; compile a `slate/` project (flows, library); both use `vscode-extension/out` |
| Tests | `test/*.test.ts` (Vitest), `test/e2e/*.playwright.ts`, `vscode-extension/src/test/suite/extension.test.ts` (Extension Host) | fixtures in `vscode-extension/test-fixtures/electron/` (`folder_project/`, `port_source/`) |
| Product landing page & demo | `src/index.html`, `dist/` | Monad-styled project showcase + web canvas demo deployed to GitHub Pages |

### Folder-mode snapshot contract

- Each node file is one `HarnessDocument`:
  `path = slate/nodes/<id>.json`, `id = node:<id>`, `source` = code text, and
  `sourceHash` = hash of the code text (not the JSON).
- The top-level unit's `id` is the node ID (path without `.json`) with
  `identity: 'durable'`. Its `annotation` is
  `{ intent, contract, dependencies: context, examples, locked }`. Child units
  (methods) keep hashed IDs.
- Unit ranges are relative to the code text. The host's `sources` map holds
  that text keyed by document path, which is what generation and search
  slice.
- In the webview, `node.data.path` is the node ID. Use
  `nodeIdOf(document.path)` to match.
- Prelude/epilogue node files set `document.nodeKind` and have no units. The
  graph node ID is the node ID itself; the host accepts it for layout and
  `setNodeCode`.

## Conventions

- **Host owns writes.** The webview posts typed messages; it never sends paths
  or ranges to trust. Node writes go through `SlateFolderHost.writeNode`
  (one `WorkspaceEdit`, then save). Layout goes through `writeLayout` (plain
  fs write, no re-index, no revision bump).
- **Serialized host state.** Panel edits (`action`, `layout`, notes, accept)
  run one at a time and `refresh()` is a chain, so `await this.refresh()`
  always reflects prior writes. Long-running work (generate, describe) and
  cancels bypass the queue. `folder.layout` is reloaded in place; keep it the
  live object.
- **Per-node staleness.** Code edits carry `baseHash` (the code hash the
  editor started from). Metadata edits read the current node fresh. Don't
  reintroduce global-revision checks for folder actions.
- **Typed actions only.** `{ type: 'action', action: { kind, ... } }`. After
  S-110 there is no string command grammar anywhere.
- **Deterministic JSON.** `serializeNode` orders keys and puts `code` last;
  `code` is a list of lines with no trailing blank lines (`codeLines`).
- **Language adapters.** Anything Python-specific (parse signature, validate
  candidate, emit compiled code) lives behind the adapter boundary so other
  languages can be added later. `indexNode` currently checks
  `language === 'python'`.
- **Tests.** Assert observable results through public functions or the host
  message API. Mutation-check new tests (break the code, confirm a failure).
  Extend existing files before adding new ones.

## Verification recipe

```bash
npx vitest run                         # harness unit tests (~1s)
npx playwright test                    # webview with fake host (~4s); uses ?demo
npm run test:electron                  # Extension Host (~45s); builds + compiles first
npm run verify:baseline                # CI gate: unit, build, port → compile → pytest of the examples
npm run package-extension              # VSIX smoke (needs network for npx vsce)
```

Static verification is now checked in: `npm run verify:static` runs strict
TypeScript checks for both active products and targeted ESLint correctness rules.
`verify:baseline` also runs the property/snapshot tests and the scoped Stryker
mutation gate. See [test/VERIFICATION.md](test/VERIFICATION.md) for scope and replay.

Visual checks: start `npx vite --port 5199`, then use a Playwright script that
stubs `window.acquireVsCodeApi` (record `postMessage` calls in
`window.__messages`). Load `/harness.html?demo`, screenshot into
`.amp/in/artifacts/`, and inspect with `view_media`, passing an objective
that states the expected result.

## Learnings and gotchas

- Extension Host tests share one panel. A test that opens the same
  `slate.json` again can read the previous test's snapshot first; close all
  editors in `finally` so the next test starts with a fresh panel. The undo
  test polls for the reverted text instead of asserting right after `undo`.
- Custom editor webviews start without options. The panel constructor sets
  `enableScripts` and `localResourceRoots`; without it the canvas is blank
  (only the workbench smoke test catches this).
- `npm run test:electron` sometimes passes and then hangs while VS Code shuts
  down. Check the log for `N passing` and kill the process if it lingers. The
  pinned VS Code (1.139) is cached in `vscode-extension/.vscode-test/`
  (≈870 MB, gitignored).
- The Extension Host fixture workspace is `test-fixtures/electron/`. Folder
  tests open `folder_project/slate/slate.json` via
  `vscode.openWith(..., 'slate.editor')` and must restore any files they
  change in `finally`.
- `slate.test.postMessage` awaits the host handler, so files are written by
  the time it returns. Use `slate.test.getSnapshot` plus polling for
  snapshot changes.
- In XYFlow, `deleteKeyCode={null}` is required; otherwise Backspace removes
  nodes from local state. Children need `parentId` and `extent: 'parent'`.
  Wires need `nodesConnectable` plus `onConnect`.
- Keyboard shortcuts must ignore `input`, `textarea`, `[contenteditable]`,
  and `.cm-editor` targets (CodeMirror). Cmd/Ctrl+K is the one global
  exception.
- Interactive elements inside XYFlow nodes need `nodrag nopan` (and
  `nowheel` for textareas), plus `stopPropagation` on double-click, or the
  canvas steals the gesture.
- Playwright: scope `getByRole('option')` to a named listbox (the palette is
  `Commands`, the picker is `Context candidates`). Edge paths have zero-height
  bounding boxes, so right-click them with `page.mouse.click` at the box
  midpoint instead of `locator.click`.
- Dropdowns inside the scrolling side panel must flow inline; absolute
  positioning gets clipped by the panel's `overflow: auto`.
- The default CodeMirror highlight is unreadable on dark backgrounds; use the
  `HighlightStyle` defined in `main.tsx`.
- Don't call `selectFromEditor` after every refresh in folder mode. It snaps
  the canvas selection back to whatever editor was last active.
- Calculator and tic-tac-toe examples live in `examples/calculator` and `examples/tic_tac_toe`. The gate ports both directly into `slate/` nodes, compiles them back to Python, and runs their pytest suites. S-001 retired `legacy/` and moved the examples to `examples/`.
- Compile uses absolute imports rooted at `outDir` (not the relative imports
  this plan first proposed): the example suites load modules as top-level
  files, and absolute imports keep the original project's import paths
  valid.
- The owner's worktree may contain their own changes (e.g. an unstaged
  `dev_notes.md` deletion, untracked `slate.slate.json` and
  `vscode-extension/vscode_extension.slate.json`). Never stage or revert
  them.
- Cost: the first thread spent about $13 on audit, cleanup, planning, and
  Phase 1a. Keep later threads focused on one phase.

## Phase 1 — `slate/` folder and a calm canvas

**Done 2026-10-13:** 1a S-100–S-103 (format, loader, folder canvas, node
creation/editing, New Project, demo), 1b S-110 (palette, typed actions,
shared types), and 1c S-111 (inline intent, context by wire, searchable
picker). The steps below are kept as the record of what was built.

### 1b — S-110 Cmd+K palette, typed actions, shared types

1. **Shared types.** Move every webview-only protocol type
   (`HarnessSearchResult`, `PacketPreview`, `HarnessProposal`, `HostMessage`)
   into `harness_protocol.ts`. `src/harness/types.ts` becomes a re-export
   (plus `type HarnessUnit = ParsedUnit`).
2. **Palette** (`src/harness/palette.ts`, pure, with Vitest). Items are
   `{ id, label, detail, group, run }`. `rankPalette(items, query)` scores
   prefix > word-start > substring > subsequence, then group order. Groups:
   selected-node actions, canvas actions, nodes (select and center), and
   "Search code for “…”" as the last item, which runs host search.
3. **UI.** Cmd/Ctrl+K opens a centered overlay (input + list, arrow keys,
   Enter, Esc). `/` opens it pre-filled for search. Replace the bottom
   command line with a slim status bar showing the last result and a ⌘K
   hint.
4. **Delete the CAD grammar.** Remove `src/harness/commands.ts` and
   `test/harness_commands.test.ts`. In the host, replace
   `handleAction → handleCommand(string)` with direct typed handling (keep
   legacy-mode behavior for intent/contract/context/lock; drop `STUB` from
   the UI because old mode retires in S-203).
5. **Tests.** Update Playwright: search goes through the palette, plus one
   palette test for selecting a node and running a node action.

### 1c — S-111 inline intent, context by wire, searchable picker

1. **Inline intent** (folder mode). Clicking the intent text on a node (or
   "add intent…" when empty) turns it into a textarea inside the node
   (`nodrag nopan` classes). Enter or blur saves via `setAnnotationField`;
   Esc cancels.
2. **Context by wire.** Set `nodesConnectable`. `onConnect({ source, target })`
   posts `setContext { consumer: target, dependency: source, enabled: true }`.
   Reject notes, children, and self-connections in `isValidConnection`.
   Right-click a context edge → **Remove context**.
3. **Searchable picker.** Replace the Inspector `<select>` with an input plus
   a filtered list using `rankPalette`.
4. **Exit check.** Screenshot the inline edit, wire drag, and picker states;
   Playwright covers wiring → message; Extension Host covers `setContext`
   writing `context` in the node JSON.

## Phase 2 — port and compile

**Done 2026-10-13:** S-200 importer, S-201 describe pass, S-202 compile with
the port → compile → pytest gate, S-203 project-v2 retirement. See
features.md for behavior. Deviations from the original design:

- Module statements split into `_prelude` (`kind: "prelude"`, before the
  first statement that needs a module definition) and `_epilogue`
  (`kind: "epilogue"`, from there on, e.g. the `__main__` guard), because a
  single prelude emitted before the nodes breaks `TABLE = {"f": f}` and the
  main guard.
- `uses` also lists same-module references (describe ordering and packets
  need them); compile skips same-folder ones.
- Compile emits absolute imports rooted at `outDir`; root-level nodes go into
  `<project name>.py` instead of `outDir/__init__.py`.
- Port skips `tests/`, `test/`, virtualenvs, hidden and build folders, and
  files that start with the Slate generated header.
- Describe keeps the node's own code whole and drops used-node lines to fit
  about 600 tokens; a node whose code alone exceeds `contextWindow − 120` is
  skipped.

## Phase 3 — one workspace and Phase 4 — ports, wires, flows

**Done 2026-10-13** (both phases in one thread). See features.md for
behavior. Decisions that differ from or sharpen the original design:

- **Root canvas = Compose.** Definitions stay on the root (with ports), plus
  refs, placeholders, flow nodes (`flow:<id>`), and values. Root data wires
  are stored in `slate/flows/main.json`; a wired canvas item's instance id is
  its canvas id (node id, ref id, `flow:<id>`, or value id) and the host adds
  or prunes those instances as wires change. Flows are separate canvases
  entered from flow nodes or flow instances.
- **Handles.** Data handles are `in:<param>` (left) and `out` / `out:<name>`
  (right); group nodes use `input:<name>` / `output:<name>` plus a `+` slot.
  Context handles are `ctx-in` (top) and `ctx-out` (bottom).
- **Positions.** Root: `layout.positions`; Map: `layout.mapPositions`;
  flows: `layout.flowPositions[flowId][instanceId | __input | __output]`. The
  `layout` message carries `scope` (`undefined`, `'map'`, or a flow id).
- **Codegen placement.** A flow compiles into the module of its folder (root
  flows and `main` into `<project>.py`) as a synthetic locked node, so compile
  reuses imports, collisions, and cycle checks. Its node id is the flow id;
  a flow id equal to a node id is an error.
- **Library ids** are `lib:<path>:<name>`; compile imports them by path as a
  module, so the project root must be on `sys.path` for those imports.
- **Keys.** Tab enters a selected flow, otherwise opens add-node search;
  Shift+A and double-click also open it; Cmd/Ctrl+G groups; Shift-click
  multi-selects. No other keys are captured on the canvas.
- **Host actions** (typed, `flow` omitted for the root): `createRef`,
  `createPlaceholder`, `placeholderToRef`, `placeholderToNode`,
  `addInstance` (optional `connectFrom`/`connectTo` + `connectPort`),
  `setValue`, `connectData`, `disconnectData`, `deleteItems`, `createFlow`,
  `extractFlow` (optional `name`), `deleteFlow`, `addLibrary`. Flow
  writes are plain fs writes followed by a refresh.
- Pure pieces: `vscode-extension/src/flow.ts` (format, ports, endpoints,
  `connect`/`disconnect`/`removeInstances`/`extractFlow`) is imported by the
  webview's `graph.ts`; keep it free of Node APIs.

## Phases 5–9 and Usability-First Critical Path (updated 2026-11-11)

Refined from the oracle review (2026-10-13) and updated on 2026-11-11 for the
**Two-Tier AI Division of Labor**, **JPL-60 atomic component library**, and
**Usability-First (Python, then Prose Mode)** sequence. Defaults: **paste
linked, fork explicitly; Live off until turned on; type mismatches warned, not
blocked.** The definition identity already exists (the node file path); do
not invent a second global id system.

Debt already fixed in the review thread: the host now honors the auto-wire
port the canvas picks (`connectPort`); refreshes are serialized and edits are
queued, so an action always sees its own writes (this also cured the flaky
Extension Host tests); `layout.json` is reloaded in place.

### Usability-First Critical Path (S-510–S-513, sequenced alongside Phase 5–7)

Goal: make day-to-day Python authoring, co-architecting, and per-node mutation
verification immediately usable before expanding into secondary language
adapters.

- **S-510 — Frontier Architect MCP server and live canvas camera sync:**
  - Expose a local Slate MCP Server bridged to the active VS Code extension host
    and webview panel.
  - Tools:
    - `slate_find`: search nodes, flows, and spatial notes by query, signature,
      or folder scope.
    - `slate_focus`: smoothly pan/zoom the live XYFlow canvas viewport to a
      specific node, note, flow, or bounding region so the user's camera tracks
      the architect conversation in real time.
    - `slate_place_notes`: create, update, and position spatial design notes on
      the canvas (`layout.json`).
    - `slate_define_stub`: create or update an atomic node stub with typed
      signature, `intent`, `contract`, `context`, and structured `cases` —
      **strictly refusing arbitrary function body code** (only `pass` / `...` /
      `raise NotImplementedError` stub bodies allowed) and supporting splitting
      oversized (`>60`-line) nodes into smaller atomic stubs.
    - `slate_wire_flow`: create/update flows and connect typed data/context
      wires deterministically via `flow.ts` and `WorkspaceEdit`.
- **S-511 — JPL-60 node hygiene guardrails:**
  - Codify **JPL-60** (relaxed NASA JPL Rule of 10) for atomic library units in
    `vscode-extension/src/slate_folder.ts` (`checkNodeCode`), compile
    diagnostics, and canvas node badges:
    - Maximum `60` lines per function node (surface a warning badge and a
      "Split / refactor into smaller stubs" prompt when exceeded).
    - Mandatory parameter and return type annotations on function signatures.
    - Bounded control flow and contract/check readiness indicators.
- **S-512 — Local `llama.cpp` stub-to-body and check forge:**
  - Extend `generation.ts` to pack a single forge input micro-packet (`≤600`
    tokens total across the target atomic stub in `slate/nodes/**/*.json` + its
    `intent`, `contract`, selected structured `cases`, any bounded retry
    feedback, and bounded neighbor signatures + intents; trimming neighbor
    context first to fit the `≤600`-token total packet budget and refusing
    oversized targets whose stub + cases + retry feedback alone exceed `600`
    tokens) and forge **both** the `≤60`-line Python implementation and its
    corresponding `Pydantic`/`pytest` unit check.
  - Enforce the JPL-60 line and signature rules on generated candidates before
    presenting proposals.
- **S-513 — Per-node `Pydantic` + `pytest` + `mutmut` verification runner and canvas badges:**
  - Run scoped per-node verification in `.slate/build/`: `Pydantic` runtime
    contract validation, `pytest` unit/case execution, and scoped `mutmut`
    mutation testing against the atomic node.
  - Surface live verification status badges on canvas nodes (untested, passing,
    contract/test failure, surviving mutants, or stale).
  - Support bounded local retry (**Try up to 3 revisions**) feeding failing test
    tracebacks or surviving mutant diffs back into the local `llama.cpp` forge
    without ever auto-accepting.

### Phase 5 — linked building blocks and trustworthy editing

Goal: reuse one definition freely, fork deliberately, and understand and undo
every structural change.

- **One occurrence model.** Every use is an instance `{ id, node }` pointing
  at a definition. `main.json` owns root call instances (root refs become
  main instances; layout keeps only placement); nested flows already work
  this way. Migrate `layout.refs` and the implied/pruned root instances
  without breaking wires. Showing a definition on the canvas does not make it
  run.
- **Copy/paste.** Cmd+C copies the selection; **Paste linked** (Cmd+V)
  creates new instances of the same definitions, no files; **Paste
  duplicate** (Cmd+Shift+V) creates new node files with fresh ids and valid
  names whose `uses` still point at existing nodes; **Make unique** forks one
  instance. Duplicating a flow forks its wiring but keeps its children linked
  (no recursive cloning). Shortcuts only when the canvas has focus.
- **Usage index.** Derived, never stored: flow instances, root instances,
  and compiler-resolved code dependencies (`uses` + unique bare names), with
  prompt-context links listed separately. "Used by N" on nodes and in the
  Inspector, navigable call sites, deletion impact. Don't double-count during
  migration.
- **Editing shared code.** A banner "Editing definition; affects N uses" with
  a Fork button — no modal on every save.
- **Undoable structural edits.** Copy, fork, group, wire, port edits, and
  deletion become one `WorkspaceEdit` across affected files (flows, layout,
  new node files), checked against dirty buffers and file versions. Pure
  positioning stays a plain write.
- **Flow ports and deletion.** Rename/remove flow inputs and outputs, updating
  caller wires or previewing what breaks. "Remove this use" vs "Delete
  definition" (with impact preview).
- **Node health report** (read-only): unreferenced candidates, exact
  duplicates (normalized code), near duplicates (heuristic), with navigation
  and diff. Label coverage gaps (dynamic imports, `import module` style); never
  call "no known references" safe to delete.
- **Canvas.** Dock/resize the Inspector instead of overlaying nodes; show
  type-mismatch warnings on wires; context links on demand so ordinary wires
  read as dataflow.
- Non-goals: automatic deduplication, dependency cloning, full type checking.
- **Exit:** place one node three times, edit once, all three change; fork
  one, only it diverges; undo both; read usage and the duplicate report on
  the canvas.
- Risk: confusing definitions with uses, or misleading usage counts.

### Phase 6 — live execution with executable cases

Goal: run the graph you chose, see its behavior, and protect shared
definitions with repeatable cases.

- **Run / Stop / Live** for a named flow or the root `main`. Selection,
  navigation, and dragging never run code; Live reruns after committed
  semantic edits, not keystrokes.
- **Runner = compiler + trace.** Reuse `compilePython`/`flowToNode` with an
  optional trace mode; no second evaluator. Immutable runs under
  `.slate/build/<run>/`; trusted workspaces only; interpreter from
  `slate.python.path` → Python extension → `python3`. Protocol messages
  separate from user stdout/stderr; time and output limits; Stop kills the
  process tree.
- **Values per use:** key observations by run id + invocation path +
  instance + port, so two linked uses (and two calls of one nested flow) show
  different values. Discard stale results by semantic fingerprint; layout
  changes never invalidate a run.
- Refuse invalid or stale graphs (no last-good runs); show failures and
  downstream "not executed". Reject unsupported call forms (async) until
  codegen handles them.
- **Values and viewers:** value instances become structured JSON literals
  (explicitly language-tagged expressions where needed; migrate today's
  Python-expression strings). Editable inputs, wire previews, pin/unpin
  viewers.
- **Cases:** structured `cases` on node and flow JSON (named inputs +
  expected output or expected exception); `examples` stays as free-text
  documentation. JSON-representable first. A viewer can propose a case from
  observed inputs; you confirm the expectation. Cases run for hand edits and
  model drafts; editing a shared node shows its cases and the affected flows'
  cases with pass/fail/stale/untested.
- Parity fixtures for known port-fidelity gaps (module docstrings, module
  state effects); never hide unresolved imports.
- Non-goals: persistent kernels, running on project open, persisting
  arbitrary objects, mute/bypass, running whole applications.
- **Exit:** two linked uses with different inputs show different results; a
  number change updates a small fixture in about a second; Stop works; a bad
  shared-node draft fails a saved case before replacing anything.
- Risk: surprising repeated side effects; results differing from normal
  compiled execution. Slices: runner, then cases, then Live.

### Phase 7 — a small local helper with guardrails

Goal: generate or revise one shared definition with bounded context and
owner-controlled verification.

- Packets take the **definition and the occurrence** it was reached from:
  target code/signature, intent/contract, bounded `uses` and immediate
  neighbors as signature + intent, explicit context summaries, selected cases.
  Never aggregate every linked use's neighborhood. Reuse Describe's
  micro-context discipline (`port/describe.ts`); full dependency bodies only on
  explicit inclusion. Show the exact packet and omissions; refuse oversized
  targets.
- Candidate edit, regenerate with feedback, cancel, llama.cpp health dot.
  Validate syntax/signature, compile in a scratch overlay, run Phase 6 cases.
- **Try up to three revisions** is an explicit action: attempts visible,
  expectations immutable, bounded failure feedback, never auto-accept. "No
  cases" = untested.
- Acceptance is bound to every packet input (code, imports/uses, intent,
  contract, lock, cases, relevant graph context), not just code hashes
  (today: `generation.ts` + `acceptFolderProposal`).
- Replace "wire a placeholder and generate it" with: create a typed stub
  from add-node search, a wire drop, or the Frontier Architect MCP
  (`slate_define_stub`), then generate its `≤60`-line body and unit check
  locally (`S-512`) and verify with `Pydantic` + `pytest` + `mutmut` (`S-513`).
  The local model does not invent the graph, and the Frontier Architect MCP
  never writes function bodies.
- Non-goals: generate-all, automatic wiring by the local model, cloud function
  body codegen. Ruff/Basedpyright optional.
- **Exit:** create a typed leaf between two nodes, add a case, generate,
  inspect a failing attempt, revise, accept, undo; linked uses stay linked.
- Risk: context creep; generating for one use while silently changing all.

### Phase 8 — explicit control flow

- Discriminated `branch` / `foreach` / `repeat` regions in flow JSON with
  explicit boundaries, reusing child flows as bodies (their inputs/outputs are
  the region contract). Ship branch, then foreach, then repeat.
- Branch: separate true/false bodies with compatible outputs. Foreach: item
  and index in, collected results out. Repeat: initial state, next state, a
  finite bound.
- Compile through the same pipeline to plain `if`/`for` (no comprehension
  optimization); only the selected branch executes.
- Create-region and group-into-region actions, visible boundary ports,
  bounded iteration inspection; invocation paths gain branch/iteration
  identity; reuse cancel and cases.
- Non-goals: arbitrary cycles, unbounded while, events, parallelism, a full
  interactive game loop.
- **Exit:** a list-processing graph and a bounded state update; inspect an
  iteration; prove an unselected branch did not run.
- Risk: eager branch evaluation; ambiguous loop-carried state.

### Phase 8.5 (S-850) — Prose / Grant & Research mode ("ComfyUI for text", `language: "prose"`)

Goal: prove the `slate/` JSON spine and Two-Tier AI architecture on structured
technical, grant, and research writing immediately after the Python usability
critical path (before TypeScript self-hosting).

- **Second adapter (`language: "prose"`):** Reuses the same `slate/` folder
  format, XYFlow canvas, flows, and Frontier Architect MCP server.
- **Wires and ports:** Data wires carry raw text passages, evidence extracts,
  claims, and structured citations (`citation`, `passage`, `section`,
  `rubric`).
- **Atomic library units (`slate/nodes/**/*.json`):** Reusable text-transform
  operators and rhetorical building blocks (e.g., synthesize evidence, tighten
  to word budget, align with agency review criterion) with explicit contracts.
- **Deterministic checks:** Automated per-node and per-flow verification of
  strict word/character budgets, required citation keys, forbidden terms, and
  section rubric completeness.
- **Compile (`compile/prose.ts`):** Deterministically assembles wired flows into
  publication-ready Markdown or LaTeX documents with bibliography resolution.
- **Exit:** wire source notes and citations through reusable prose operators,
  enforce word budgets and required citations via deterministic checks, and
  compile a multi-section grant/research document to Markdown/LaTeX.

### Phase 9 — TypeScript and staged self-hosting (deferred behind Python & Prose usability)

- A real adapter boundary for index/signature/ports, stubs, replacement
  validation, describe/generate prompts, import resolution, and compile.
  Python keeps working; no cross-language execution.
- TS and TSX: functions and arrow declarations, types/interfaces,
  imports/exports, ambient declarations, module initialization, side-effect
  imports. Preserve module paths, order, and `.ts`/`.tsx` through module JSON
  (Python's folder-to-module rule is not enough).
- Class methods as durable node files with an explicit owning class; class
  JSON holds header, fields, and ordered member references (no duplicated
  method source); preserve constructors, static/private members, `this`,
  overloads.
- React closures stay inside their component unless explicitly extracted with
  parameters; a method adapter alone does not solve `HarnessApp`'s captured
  hook state.
- Staged gate: pure TS modules → an extension class with editable methods →
  a TSX component → full extension + webview rebuild and smoke test. Compile
  into a separate tree before cutover. Compile must refuse to overwrite files
  it did not generate (`port_compile_host.ts` writes output paths
  unconditionally today).
- Build tooling and assets stay outside the authored-code model.
- Non-goals: hot self-modification, Node/browser live evaluation, extracting
  every closure.
- **Exit:** change an extension method and a React component through Slate,
  rebuild, and launch the result with both changes working and undo
  available.
- Risk: preserving module/closure semantics, not parsing.

## Phase log

- **2026-10-13 — Phase 0 + 1a** ([thread](https://ampcode.com/threads/T-01a13361-a960-7632-aa1d-d4398dbc57c4)).
  Removed the LibCST engine; moved the notebook to `legacy/`; reset the plan
  to a composable node canvas; adopted the per-node JSON `slate/` folder;
  shipped S-100–S-103. Commits `92a4148`, `85c88a7`.
- **2026-10-13 — Phase 1b + 1c** (same thread). Cmd+K palette (`palette.ts`
  ranking + `CommandPalette`), status bar, CAD grammar and string round trip
  deleted, protocol types shared (webview re-exports), webview type errors
  fixed (0 baseline), inline intent, wire → context, edge menu, searchable
  picker. Tests: Vitest palette ranking; Playwright palette and wiring
  journeys; Extension Host folder `setContext` and a legacy typed-action
  undo. Phase 1 exit is the owner's "an hour without fighting it" check,
  which is pending.
- **2026-10-13 — Phase 2** ([thread](https://ampcode.com/threads/T-01a13634-1fde-7738-9ca4-8d7eea11e71a)).
  Port Python Project (`port/python_importer.ts`), Describe nodes
  (`port/describe.ts`), Compile Project (`compile/python.ts`), host wiring in
  `port_compile_host.ts`, module-state nodes on the canvas, and the
  `verify:baseline` gate (calculator 7 and tic-tac-toe 8 pytest cases pass on
  compiled output). Retired project-v2 mode entirely. Fixed the custom editor
  webview never enabling scripts. Tests: Vitest port/compile goldens and
  describe against the fake llama server (ordering, resume, malformed, timeout,
  cancel); Extension Host port → describe → compile, dirty node buffers,
  notes in layout.json.
- **2026-10-13 — Phases 3 + 4** (same thread). Typed params on units and
  ports on the canvas; refs, placeholders, library sidebar and read-only
  library code, Compose/Map; flows with data wires, group IO, Ctrl+G
  extraction, Tab/breadcrumbs, add-node search with type-filtered wire drop;
  flow codegen in compile; `examples/flow_demo` gate (3 pytest cases). Tests:
  Vitest flow format/extract/codegen goldens and graph scopes; Playwright
  refs/placeholders/wires/flows/grouping/library drag/Map; Extension Host
  refs → wires → flows → extract → compile.
- **2026-10-13 — Plan review** (same thread). Oracle review of plan and code
  produced refined Phases 5–9 (linked reuse and undo → live execution with
  cases → local helper → control flow → TypeScript self-hosting). Fixed the
  ignored auto-wire port, serialized panel refreshes and queued edits (the
  root cause of flaky Extension Host tests), and reload layout in place.
- **2026-11-11 — Architecture & Usability-First Critical Path update.**
  Codified the **Grasshopper atomic component forge** mental model (`JPL-60`
  atomic library units in `slate/nodes/**/*.json` ≤60 lines verified by
  `Pydantic` + `pytest` + `mutmut`; deterministic `flowToNode` compositions in
  `slate/flows/**/*.json`), the **Two-Tier AI Division of Labor** (Tier 1
  Frontier Architect via Slate MCP Server with live camera sync and zero
  function bodies; Tier 2 local `llama.cpp` component forge), and the
  Usability-First roadmap slices (`S-510`–`S-513` for Python usability, followed
  by `S-850` Prose / Grant & Research Mode `language: "prose"`, keeping Phase 9
  TypeScript self-hosting deferred behind usability).
- **2026-11-13 — Phase 7 (S-700 & S-701).** Shipped occurrence-aware micro packets
  (`S-700`, Issue #12) and verified candidates & revision loop (`S-701`, Issue #13).
  Unbundled local LLM architecture where frontier architect configures endpoints via
  MCP tools `slate_llm_status` and `slate_configure_llm`. Local LLM health dot and
  interactive test/config modal dialog in top bar and Inspector. Candidate review editor
  in Inspector enabling direct editing of proposed body and check before accept.
  Scratch-overlay guardrail verification in isolated scratch directory (`.slate/scratch/`)
  running Pydantic, pytest, and mutmut checks without altering disk files. Bounded feedback
  regeneration within micro-packet budget (`<=600` tokens) with neighbor context trimming.
  One-click "Try up to 3 revisions" loop with immutable expectations and failure tracebacks.
  Strict acceptance binding across inputs, hashes, cases, and neighbor signatures.
  Typed stubs created from wire drops and canvas search with auto-wiring.
  Full launch gate green (736 Vitest unit tests, 103 Playwright webview tests,
  66 Extension Host tests, and workbench QA).
