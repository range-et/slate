# Slate build plan — agent handoff

The implementation playbook for whoever builds the next phase (human or
agent). [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md) says *what and why*,
[issues.md](issues.md) lists tasks with acceptance criteria, and
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
4. **Close the phase:** move shipped items from issues.md to features.md,
   update this file's design for later phases if anything changed, append a
   **Phase log** entry (bottom of this file), and commit.

## Owner intent (keep this front of mind)

- The goal is Grasshopper / Blender Geometry Nodes / Unreal Blueprints for
  code: one large canvas, compose nodes freely, and wires mean dataflow.
- The local LLM (llama.cpp) writes small pieces with microscopic context.
  It's a helper, never the driver. No cloud fallback.
- The source of truth is a `slate/` folder of JSON only: one file per node,
  plus JSONs that refer to nodes by ID. Compile generates `src/`. The format
  must stay language-agnostic (Python first; C# and others later through
  adapters).
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
| Panel / webview host | `vscode-extension/src/harness_panel.ts` | ~620 lines, folder only; typed actions incl. `compile`, `describeNodes`, `cancelDescribe` |
| Python parsing | `vscode-extension/src/python_adapter.ts` | Lezer; `parseModule(source, path, nodeId?)`; `replaceUnit`; `splitImport`, `identifierNames`, `topLevelBindings` |
| Port / describe | `vscode-extension/src/port/python_importer.ts`, `port/describe.ts` | pure; importer `portPythonProject(files)`; describe order/packet/parse/loop |
| Compile | `vscode-extension/src/compile/python.ts` | pure `compilePython(nodes, config)` → files + diagnostics |
| Port/compile host | `vscode-extension/src/port_compile_host.ts` | `portPythonFolder`, `compileSlateFolder`, the `Slate` output channel |
| Protocol types | `vscode-extension/src/harness_protocol.ts` | shared host ↔ webview types (webview re-exports them) |
| Generation | `vscode-extension/src/generation.ts`, `llama_transport.ts` | packet builder (uses `annotation.intent/contract/dependencies/locked`), SSE transport (optional `system`) |
| Search | `vscode-extension/src/search.ts` | ranks units over documents + `sources` |
| Extension entry | `vscode-extension/src/extension.ts` | commands (open, new, port, compile), custom editor (`**/slate/slate.json` only), launcher view, test-only commands |
| Webview app | `src/harness/main.tsx` | React + XYFlow; Inspector, menus, command UI |
| Graph building | `src/harness/graph.ts` | `buildGraph` → `buildFolderNodes` (incl. module-state nodes), notes, and edges |
| Demo snapshot | `src/harness/demo.ts` | `?demo` (any value) loads it; Playwright uses it |
| Gate script | `scripts/port-compile.js` | port a folder and compile it with the built `vscode-extension/out` modules |
| Tests | `test/*.test.ts` (Vitest), `test/e2e/*.playwright.ts`, `vscode-extension/src/test/suite/extension.test.ts` (Extension Host) | fixtures in `vscode-extension/test-fixtures/electron/` (`folder_project/`, `port_source/`) |
| Legacy notebook | `legacy/` | frozen; Pages deploys it; keep `verify:baseline` green |

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
npm run verify:baseline                # CI gate incl. legacy, port → compile → pytest of the examples
npm run package-extension              # VSIX smoke (needs network for npx vsce)
```

Webview type-check (there is no root `tsc`; borrow the extension's). Put
this config in `.amp/in/tsc.json` and run
`vscode-extension/node_modules/.bin/tsc -p .amp/in/tsc.json`:

```json
{ "compilerOptions": { "jsx": "react-jsx", "strict": true, "noEmit": true, "module": "esnext",
  "moduleResolution": "bundler", "target": "es2022", "lib": ["es2022", "dom"], "skipLibCheck": true,
  "typeRoots": ["<repo>/node_modules/@types"], "types": [] },
  "files": ["<repo>/src/harness/main.tsx", "<repo>/.amp/in/env.d.ts"] }
```

`env.d.ts`: `interface ImportMeta { env: { DEV: boolean } }` and
`declare module '*.css';`. The baseline is **0 errors**; keep it there.

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
- The checked-in `legacy/examples/tic_tac_toe/game.py` lacks its imports, so
  the gate ports the legacy compile output (`$TMP/tic_tac_toe`) instead.
  Calculator is ported from the checked-in files. When `legacy/` is deleted
  (S-001), move those Python sources and their tests somewhere the gate can
  still reach.
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

## Phase 3 — one workspace

- **Reference nodes.** `layout.json.refs: [{ id, target }]` with positions in
  `positions[id]`. They render as compact pills with the target's ports. Menu:
  Go to definition (select and center the target), Find references
  (highlight), Generate body. A missing target renders broken.
- **Placeholders.** `layout.json.placeholders: [{ id, name, signature? }]`.
  If the name resolves to a node, offer "Convert to reference". **Create
  node** uses `nodeFromSignature` with the inferred or entered signature.
- **Library sidebar.** A left panel listing nodes by folder plus read-only
  library code (`slate.json.library: ["path", ...]` indexed by the Lezer
  adapter; library units are callable but not editable). Dragging onto the
  canvas creates a ref.
- **Compose/Map.** Map lays nodes out by folder grid, using
  `layout.mapPositions`. Compose uses `positions`.

## Phase 4 — ports, wires, flows

- **Structured params.** Add to `ParsedUnit`:
  `params: Array<{ name, annotation | null, default | null, kind:
  'positional' | 'keyword' | 'var' | 'kwvar' }>` from the `ParamList` nodes.
- **Handles.** One per param (`in:<name>`) on the left and `out` on the
  right, colored by annotation (hash → palette; "any" is grey). A separate
  small context handle on top.
- **Flow JSON** (`slate/flows/<name>.json`):
  ```json
  { "slate": 3, "name": "score_pipeline",
    "inputs": [{ "name": "score", "annotation": "int" }],
    "outputs": [{ "name": "result", "annotation": "int" }],
    "instances": [{ "id": "n1", "node": "clamp" }, { "id": "v1", "kind": "value", "value": 0 }],
    "wires": [{ "from": "input:score", "to": "n1.in:value" }, { "from": "n1.out", "to": "output:result" }] }
  ```
  The root canvas edits `slate/flows/main.json`. A flow is itself callable as
  a node in other flows.
- **Codegen** (in Compile): topological sort over instances;
  `vN = node(arg=...)`; unwired params use defaults or raise a diagnostic;
  return a single value or a tuple. Golden tests cover fan-out, multiple
  outputs, unused inputs, and name collisions.
- **Ctrl+G** extracts the selection into a new flow (boundary wires become
  inputs/outputs) and replaces it with one instance. Tab enters a flow;
  breadcrumbs exit.
- **Add-node search:** Tab, double-click, or Shift+A opens the palette in
  "add" mode at the cursor; dropping a wire onto empty space opens it filtered
  by type.

## Phase 5 — live values

- `runner/slate_runner.py` is shipped as a string. The host compiles a traced
  build into `.slate/build/` where each instance assignment also records
  `repr(v)[:200]`, `type(v).__name__`, or the exception per instance. It runs
  the interpreter (`slate.python.path` →
  `python.defaultInterpreterPath` → `python3`) with JSON over stdio, a
  timeout, and cancel. Trusted workspaces only, with Live toggled on.
- Input/Viewer/Example instances; `examples` seed inputs. Debounce re-runs by
  300 ms; M mutes (bypasses) an instance; errors render on the instance.

## Phase 6 — model inside the graph

- Packet = node code/signature + intent + upstream/downstream instance
  signatures and intents + explicit context + example values seen on its
  input wires. Run the candidate on examples through the runner before
  review. Iterate up to 3 times, feeding back the failing example and
  traceback. Add edit/regenerate in review and a llama health dot in the top
  bar.

## Phase 7 — zones

- Zone entries in flow JSON:
  `{ id, kind: 'foreach' | 'repeat' | 'branch', instances: [...], inputs, outputs }`.
  Codegen: list comprehension when the body is a single expression chain, else
  `for`; repeat carries state; branch → `if/else` with outputs merged. The
  runner shows values for the first N iterations.

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
  notes in layout.json. **Next thread: Phase 3** (reference nodes,
  placeholders, library sidebar, Compose/Map).
