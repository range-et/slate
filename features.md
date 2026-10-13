# Slate — feature inventory

Factual inventory of what exists, what is half-built, and what is not started.
Direction and reasoning live in [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md);
executable tasks live in [issues.md](issues.md). Audited 2026-10-13 (after Phase 2).

## At a glance

| Area | State |
| --- | --- |
| `slate/` folder of node JSON (format, loader, host IO) | ✅ shipped |
| Folder-mode canvas (free nodes, click-select, layout.json) | ✅ shipped |
| Node creation + intent/contract/context/code/lock editing | ✅ shipped |
| Python indexing (TypeScript/Lezer, dirty buffers) | ✅ shipped |
| Port Python project → node files (imports, uses, module state) | ✅ shipped |
| Micro-context llama.cpp describe pass (leaves first, resumable) | ✅ shipped |
| Compile `slate/` → Python modules (verified by original pytest suites) | ✅ shipped |
| Search + exact reveal | ✅ shipped |
| Board notes (free text, optional attachment) | ✅ shipped |
| Explicit context + packet preview | ✅ shipped |
| Single-function llama.cpp generate → review → accept → undo | ✅ shipped, no edit/regenerate |
| Cmd+K command palette (actions, go-to-node, search) | ✅ shipped |
| Context by wire, edge menu, searchable picker; inline intent on nodes | ✅ shipped |
| Wiring nodes / typed ports / dataflow | ❌ not started (handles are drawn but not connectable) |
| Reference (alias) nodes, "go to function" from anywhere | ❌ not started |
| Placeholder nodes (name-only → stub) | ❌ not started |
| Composite (group) nodes compiled to Python | ❌ not started |
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
  `examples`, `describedBy`, `locked`, `imports`, `uses` (node IDs the code
  references), `order` (compile order), `kind` (`prelude`/`epilogue` for
  module-level statements), `language`. Unknown keys are preserved and
  serialization is deterministic (`vscode-extension/src/slate_folder.ts`).
- **Indexing.** Each node's code is parsed by the Lezer adapter. Diagnostics
  cover malformed JSON, missing or misnamed definitions, extra statements, a
  file name that doesn't match `name`, and languages without an adapter. A
  broken node keeps its last good graph, marked stale.
- **Canvas.** Every node is a free node, with no file containers; classes
  contain their methods. Default grid columns follow folders. Each node shows
  its intent and a `!` badge for problems. Prelude/epilogue nodes render as
  small "module state"/"module tail" nodes whose code is editable in the
  workbench. Click selects only; double-click
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
- **Palette.** Cmd/Ctrl+K or `/` opens a ranked palette. It holds actions on
  the selection (open, generate, lock, add note, add/remove context), canvas
  actions (new node, new note, fit, refresh, save, clear), go-to for every
  node and note, and "Search code for …". A status bar shows the last result.
  The uppercase/`::` command grammar and its host string round trip were
  removed.
- **Context by wire.** Dragging from a node's right handle to another node's
  left handle adds the first as context of the second. Right-clicking a
  context edge offers **Remove context**. The workbench picker is a
  searchable list that matches names, signatures, and intents.
- **Inline intent.** Clicking a node's intent (or "add intent…") edits it in
  place; Enter or blur saves, and Esc cancels.
- **Generation.** Packets are built from node code and context nodes, and
  accepted candidates are written into the node's `code` after rechecking
  every packet item's hash.
- **Projects.** **Slate: New Project** creates `slate/`, and
  `slate/slate.json` opens in the canvas (the only custom editor).
  **Slate: Open Python Harness** without a `slate/` folder offers New Project
  or Port Python Project…. `examples/llama_demo` uses the format.
- **Tests.** Vitest covers the format, diagnostics, and packets; the
  Extension Host suite covers dirty-buffer indexing, reveal, native undo of
  host edits, notes in layout.json, layout-without-reindex, metadata edits,
  and stale/renamed/valid code saves.

## Shipped — port, describe, compile (Phase 2)

- **Port** (`port/python_importer.ts`, command **Slate: Port Python
  Project…**). Module `a/b.py` → folder `a/b/` (`a/__init__.py` → `a/`); each
  top-level def/class → `a/b/<name>` with comments above it. Import
  statements are split per binding; each node keeps only the imports whose
  names its code uses. Imports of ported definitions or prelude names (absolute,
  sibling-script, or relative) are dropped and recorded as `uses`, as are
  same-module references. Module statements before the first one that needs a
  definition go to `_prelude`; the rest (e.g. `if __name__ == ...`) go to
  `_epilogue`. The report lists star imports, aliased or non-node imports
  from ported modules, conditional definitions, `global` use, duplicate
  definitions, and unparsable files. Tests, virtualenvs, hidden and build
  folders, and Slate-generated files are skipped; the source is never written.
  Porting refuses a non-empty `slate/nodes`.
- **Describe** (`port/describe.ts`, palette **Describe nodes with
  llama.cpp** / **Stop describing**). Definition nodes without an intent, in
  dependency order over `uses` (cycles broken by node ID). Each packet is the
  node's code plus `signature — intent` of the nodes it uses, trimmed to about
  600 input tokens, 120 output tokens. Replies must be `intent:` plus optional
  `contract:`, one line each, at most 240 characters; malformed replies retry
  once, then the node is skipped and listed in Output → Slate. Writes set
  `describedBy: "llama"` and never overwrite an intent written meanwhile.
- **Compile** (`compile/python.ts`, command **Slate: Compile Project** and
  palette **Compile project**). One module per folder (`a/b/` → `a/b.py`, or
  `a/b/__init__.py` when it has subfolders; root nodes → `<project>.py`), plus
  package `__init__.py` markers. Header → `from __future__` → merged external
  imports → absolute imports for cross-module `uses` (and bare names that match
  exactly one node elsewhere) → prelude → nodes by `order` → epilogue, each
  block stamped `# slate: nodes/<id>` with intent/contract comments.
  Diagnostics: invalid code, missing `uses`, name collisions, ambiguous names
  (errors, nothing written), and module import cycles (warning). Stale
  generated files in `outDir` are deleted; other files are kept.
- **Gate.** `scripts/port-compile.js` + `verify:baseline` port the calculator
  and tic-tac-toe examples, compile them, and run their original pytest
  suites against the output.

## Shipped — shared platform

### Indexing

- Pure TypeScript Python adapter on `@lezer/python`: classes, functions,
  methods, nested declarations, decorators, async/multiline signatures,
  parameters, return annotations, UTF-16 ranges, CRLF, Unicode, syntax
  diagnostics; the node's definition is durable, nested units provisional.
  Import splitting, identifier and top-level binding helpers for port/compile.
- Dirty buffers outrank disk. Invalid nodes keep a visibly stale last-good
  graph.

### Canvas

- Context edges (animated) and note attachment edges (dotted) are drawn.
- Right-click menus for empty canvas, functions, and notes.
- Trackpad two-finger pan, pinch zoom, node drag.

### Search

- Host search ranks names, qualified names, IDs, signatures, annotations,
  paths, and dirty-buffer text; results explain why they matched (run from
  the palette).
- Node edits are one VS Code `WorkspaceEdit` on the node file with native
  undo.

### Notes

- Free-text board notes persist in `layout.json` and never touch node files.
- A note can attach to one function and draws a dotted edge to it.

### Local generation (llama.cpp)

- Inspector edits intent/contract, shows context chips, adds/removes context
  through a dropdown, and previews the exact packet with a token estimate.
- Host-side OpenAI-compatible streaming transport with timeout and cancel. No
  model picker, no cloud fallback.
- Eligibility: typed, unlocked node functions with an intent.
- Candidates are rejected for syntax errors, extra statements, decorators,
  renames, signature changes, or edits outside the function. Acceptance
  rechecks hashes, applies one `WorkspaceEdit`, and supports undo.
- `npm run demo:llama` + `examples/llama_demo` run the loop end to end.

### Test platform

- Vitest unit suites (adapter, folder format, port, compile, describe,
  search, palette, graph, packet, transport, fake llama server).
- Playwright against `harness.html` with an injected fake VS Code host.
- `@vscode/test-electron` Extension Host suite (dirty buffers, reveal,
  `WorkspaceEdit`, undo, notes, port → describe → compile) and a
  Playwright/Electron workbench smoke test that renders the custom editor.
- `npm run verify:baseline` and `npm run test:harness` compose the suites; CI
  runs both.

## Partially done

- **Context entry points.** Wire, palette, and picker are shipped; `@`
  completion inside intent text is not.
- **Proposal lifecycle.** Generated code is reviewed, but intent/contract/
  context/lock edits apply immediately without review. Candidates cannot be
  edited or regenerated with feedback.
- **llama.cpp.** No health indicator; no bounded revision loop.
- **Examples.** Only `examples/llama_demo` ships a `slate/` folder.
  Calculator and tic-tac-toe stay in `legacy/examples/` as Python and are
  ported on the fly by the gate. Their legacy `## @slate …` comment lines are
  kept verbatim as ordinary comments in the ported nodes.
- **Port fidelity.** Module docstrings land in the prelude (after imports), so
  compiled modules lose `__doc__`. `import pkg` style references to ported
  modules stay plain imports (no `uses`). Bare-name resolution in compile
  does not know about local shadowing, so a local variable named like a node
  elsewhere imports that node (harmless unless it forms a cycle).
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

- 2026-10-13 (S-203): the project-v2 source-map mode — `project_v2.ts`,
  `contracts/project-v2.schema.json`, `*.slate.json` custom editor, `## @slate`
  annotation parsing and its syntax grammar, adapter `adoptUnit` /
  `updateAnnotation` / `insertStub`, **Scan Python Workspace**, the legacy
  panel branches, `buildSourceMapNodes`, the legacy demo snapshot, and
  `HarnessSnapshot.mode`. Fixtures `fixture.slate.json` and `sample.py`.

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
