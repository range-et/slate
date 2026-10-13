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
  notes in layout.json.
- **2026-10-13 — Phases 3 + 4** (same thread). Typed params on units and
  ports on the canvas; refs, placeholders, library sidebar and read-only
  library code, Compose/Map; flows with data wires, group IO, Ctrl+G
  extraction, Tab/breadcrumbs, add-node search with type-filtered wire drop;
  flow codegen in compile; `examples/flow_demo` gate (3 pytest cases). Tests:
  Vitest flow format/extract/codegen goldens and graph scopes; Playwright
  refs/placeholders/wires/flows/grouping/library drag/Map; Extension Host
  refs → wires → flows → extract → compile. **Next thread: Phase 5** (live
  values: runner, viewers, examples).
