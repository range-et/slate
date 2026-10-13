# Slate — feature inventory

Factual inventory of what exists, what is half-built, and what is not started.
Direction and reasoning live in [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md);
executable tasks live in [issues.md](issues.md). Audited 2026-10-13.

## At a glance

| Area | State |
| --- | --- |
| `slate/` folder of node JSON (format, loader, host IO) | ✅ shipped |
| Folder-mode canvas (free nodes, click-select, layout.json) | ✅ shipped |
| Node creation + intent/contract/context/code/lock editing | ✅ shipped |
| Python indexing (TypeScript/Lezer, dirty buffers, annotations) | ✅ shipped |
| Source map canvas (files → classes → functions) | ✅ legacy mode, retiring in S-203 |
| Search + exact reveal | ✅ shipped |
| Board notes (free text, optional attachment) | ✅ shipped |
| Explicit context (`depends-on`) + packet preview | ✅ shipped, entry points clumsy |
| Single-function llama.cpp generate → review → accept → undo | ✅ shipped, no edit/regenerate |
| CAD-style command line | ✅ shipped — replaced by Cmd+K in S-110 |
| Wiring nodes / typed ports / dataflow | ❌ not started (handles are drawn but not connectable) |
| Reference (alias) nodes, "go to function" from anywhere | ❌ not started |
| Placeholder nodes (name-only → stub) | ❌ not started |
| Composite (group) nodes compiled to Python | ❌ not started |
| Importer + micro-context LLM descriptions; Compile to `src/` | ❌ not started (Phase 2) |
| Running code / live values on wires | ❌ not started |
| Loops / zones (repeat, for-each, branch) | ❌ not started |
| Ruff / Basedpyright / pytest validation of proposals | ❌ not started |
| Queue / generate-all in the new harness | ❌ not started |
| Legacy browser notebook (`legacy/`) | 🧊 frozen, still deployed to GitHub Pages |

## Shipped — `slate/` folder (decoupled JSON workspace)

- **Format.** `slate/slate.json` (name, default language, compile target),
  `slate/layout.json` (positions, notes), and one `slate/nodes/**/*.json` per
  node. The node ID is the path without `.json`. Fields: `name`, `code`
  (list of lines, one definition), `intent`, `contract`, `context` (node IDs),
  `examples`, `describedBy`, `locked`, `imports`, `language`. Unknown keys are
  preserved and serialization is deterministic
  (`vscode-extension/src/slate_folder.ts`).
- **Indexing.** Each node's code is parsed by the Lezer adapter. Diagnostics
  cover malformed JSON, missing or misnamed definitions, extra statements, a
  file name that doesn't match `name`, and languages without an adapter. A
  broken node keeps its last good graph, marked stale.
- **Canvas.** Every node is a free node, with no file containers; classes
  contain their methods. Default grid columns follow folders. Each node shows
  its intent and a `!` badge for problems. Click selects only; double-click
  or Enter opens the node JSON; `/` focuses the command line; Backspace no
  longer deletes canvas nodes.
- **Persistence.** Dragging writes `layout.json` as a plain file write, with
  no re-index or revision bump. Notes live in `layout.json`.
- **Editing.** Right-click → **New node…** creates a node from a typed
  signature and intent at the click point. The workbench edits intent,
  contract, context, lock, and code (CodeMirror with Python highlighting).
  Code saves are hash-checked against the version you started from, and must
  be one definition with the node's name. Every edit is one `WorkspaceEdit`
  on the node file.
- **Generation.** Packets are built from node code and context nodes, and
  accepted candidates are written into the node's `code` after rechecking
  every packet item's hash.
- **Projects.** **Slate: New Project** creates `slate/`, and
  `slate/slate.json` opens in the canvas. `examples/llama_demo` uses the
  format.
- **Tests.** Vitest covers the format, diagnostics, and packets; the
  Extension Host suite covers indexing, layout-without-reindex, metadata
  edits, and stale/renamed/valid code saves.

## Shipped — source-map harness (VS Code extension, retiring in S-203)

### Indexing and project model

- Pure TypeScript Python adapter on `@lezer/python`: classes, functions,
  methods, nested declarations, decorators, async/multiline signatures,
  parameters, return annotations, UTF-16 ranges, CRLF, Unicode, syntax
  diagnostics, durable/provisional IDs, and duplicate-ID detection.
- `## @slate v=2 id=…` … `## @slate-end` annotations own identity, `intent`,
  `contract`, `depends-on`, `example`, and `locked`.
- Dirty buffers outrank disk. Invalid source keeps a visibly stale last-good
  graph.
- Project-v2 `.slate.json` (schema in `contracts/project-v2.schema.json`) owns
  tracked paths, layout, notes, and queue state. Legacy projects migrate in
  memory; newer schemas open read-only.
- **New Project** and **Scan Python Workspace** commands create a project file.

### Canvas

- XYFlow canvas: files and classes render as nested containers holding
  function/method nodes. Layout persists to the project file.
- Click selects (in both modes since 2026-10-13); double-click, Enter, or
  **Edit in code** reveals and focuses the source. Editor cursor highlights
  the deepest containing node.
- Context edges (animated) and note attachment edges (dotted) are drawn.
- Right-click menus for empty canvas, functions, and notes.
- Trackpad two-finger pan, pinch zoom, node drag.

### Search and commands

- `/search` ranks names, qualified names, IDs, signatures, annotations, paths,
  and dirty-buffer text; results explain why they matched.
- Command line with completion/history: `SELECT`, `REVEAL`, `EDIT`, `FIT`,
  `CLEAR`, `STUB`, `INTENT`, `CONTRACT`, `CONTEXT`, `UNCONTEXT`, `LOCK`,
  `COMPILE`, `SAVE`, `HELP`.
- All source mutations go through adapter proposals and one VS Code
  `WorkspaceEdit` with native undo.

### Notes

- Free-text board notes persist in project metadata and never touch source.
- A note can attach to one function and draws a dotted edge to it.

### Local generation (llama.cpp)

- Inspector edits intent/contract, shows context chips, adds/removes context
  through a dropdown, and previews the exact packet with a token estimate.
- Host-side OpenAI-compatible streaming transport with timeout and cancel. No
  model picker, no cloud fallback.
- Eligibility: typed, unlocked, durable functions/methods with an intent.
- Candidates are rejected for syntax errors, extra statements, decorators,
  renames, signature changes, or edits outside the function. Acceptance
  rechecks hashes, applies one `WorkspaceEdit`, and supports undo.
- `npm run demo:llama` + `examples/llama_demo` run the loop end to end.

### Test platform

- Vitest unit suites (adapter, project-v2, search, commands, graph, packet,
  transport, fake llama server).
- Playwright against `harness.html` with an injected fake VS Code host.
- `@vscode/test-electron` Extension Host suite (dirty buffers, reveal,
  `WorkspaceEdit`, undo) and a Playwright/Electron workbench smoke test.
- `npm run verify:baseline` and `npm run test:harness` compose the suites; CI
  runs both.

## Partially done

- **Context entry points.** Context can be added only through the inspector
  dropdown or `CONTEXT a :: b`. `@`, drag-to-connect, and the node menu do not
  open a shared picker.
- **Proposal lifecycle.** Generated code is reviewed, but intent/contract/
  context/lock edits apply immediately without review. Candidates cannot be
  edited or regenerated with feedback.
- **llama.cpp.** No health indicator; no bounded revision loop.
- **Examples.** Only `examples/llama_demo` uses the `slate/` folder format.
  Calculator and tic-tac-toe moved to `legacy/examples/` because they use the legacy
  `## @slate id=… prompt:` annotation (no `@slate-end`), which the harness
  shows as provisional, intent-less nodes.
- **Retirement.** The extension, VSIX, and root build are harness-only. The
  legacy notebook is isolated in `legacy/` and still deployed by GitHub Pages.

## Not started

- Connectable ports derived from parameters/return types; dataflow wires.
- Reference nodes (many canvas instances of one function) with go-to-definition
  and find-references.
- Placeholder notes that turn into typed stubs.
- Composite/group nodes that generate a Python function body.
- Input, viewer, and example nodes; executing code; showing values.
- Repeat / for-each / branch zones.
- Add-node search on the canvas (Tab, double-click, drag from port).
- Inline code on nodes.
- Ruff, Basedpyright, targeted pytest validation of candidates.
- Dependency-ordered queue / generate-all for the harness.
- Static product page replacing the GitHub Pages authoring app; clean-profile
  VSIX install/update/restart test.
- Any language other than Python (Slate cannot map its own TypeScript code).

## Legacy browser notebook (frozen)

`legacy/` holds the original card notebook (`legacy/src/`, tests, scripts,
examples, and its docs: README, ARCHITECTURE, DEPLOYMENT, motivation): Project → Document → Card JSON, markdown/code/
header cards, `@` references with bibliography, OpenAI/Gemini/OpenAI-compatible
agents, Generate All, Compile All to Python, `## @slate` round-trip, a D3
graph, and the calculator/tic-tac-toe compile fixtures. Run it with
`npm run legacy:dev`, `legacy:build`, and `legacy:test`;
`npm run verify:baseline` keeps it green and `.github/workflows/pages.yml`
deploys `legacy/dist`. It is not shipped in the extension and receives no new
work. Delete the folder once the harness replaces the site.

## Removed

- 2026-10-13: the legacy notebook moved from `src/`, `test/`, `scripts/`,
  `examples/`, and root docs into `legacy/`. The root Vite build now emits
  only `harness.html`, and extension packaging no longer stubs API-key config.
- 2026-10-13: LibCST Python engine (`python-engine/`), the retired
  `worker-protocol-v1` contract, `scripts/verify-phase1.mjs`,
  `scratch/sample_project.json`, and the `setup:python-engine` /
  `test:python-engine` scripts. The TypeScript adapter and its tests cover the
  same behavior; history remains in Git.
- 2026-09-23: legacy notebook commands, custom editor, state bridge, browser
  model UI, and Python worker bootstrap removed from the extension.
