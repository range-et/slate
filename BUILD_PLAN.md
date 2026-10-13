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
| Folder format (pure) | `vscode-extension/src/slate_folder.ts` | parse/serialize slate.json, layout.json, node JSON; `indexNode`, `checkNodeCode`, `nodeFromSignature` |
| Folder IO (VS Code) | `vscode-extension/src/slate_folder_host.ts` | index folder, read/write nodes (WorkspaceEdit + save), layout (fs write), create node |
| Panel / webview host | `vscode-extension/src/harness_panel.ts` | ~1100 lines; folder-mode branches come first; old project-v2 branches are deleted in S-203 |
| Python parsing | `vscode-extension/src/python_adapter.ts` | Lezer; `parseModule(source, path, nodeId?)`; `replaceUnit` (confined function replacement); old annotation/stub helpers are deleted in S-203 |
| Protocol types | `vscode-extension/src/harness_protocol.ts` | shared host ↔ webview types (webview re-exports them after S-110) |
| Generation | `vscode-extension/src/generation.ts`, `llama_transport.ts` | packet builder (uses `annotation.intent/contract/dependencies/locked`), SSE transport |
| Search | `vscode-extension/src/search.ts` | ranks units over documents + `sources` |
| Old source-map mode | `vscode-extension/src/project_v2.ts`, `## @slate` parts of the adapter | retire in S-203 |
| Extension entry | `vscode-extension/src/extension.ts` | commands, custom editor (`*.slate.json`, `**/slate/slate.json`), test-only commands |
| Webview app | `src/harness/main.tsx` | React + XYFlow; Inspector, menus, command UI |
| Graph building | `src/harness/graph.ts` | `buildGraph` → folder mode (`buildFolderNodes`) or legacy (`buildSourceMapNodes`), plus notes and edges |
| Demo snapshots | `src/harness/demo.ts` | `?demo` = legacy source map (Playwright uses it); `?demo=folder` = folder mode |
| Tests | `test/*.test.ts` (Vitest), `test/e2e/*.playwright.ts`, `vscode-extension/src/test/suite/extension.test.ts` (Extension Host) | fixtures in `vscode-extension/test-fixtures/electron/` (incl. `folder_project/`) |
| Legacy notebook | `legacy/` | frozen; Pages deploys it; keep `verify:baseline` green |

### Folder-mode snapshot contract

- `snapshot.mode === 'folder'`. Each node file is one `HarnessDocument`:
  `path = slate/nodes/<id>.json`, `id = node:<id>`, `source` = code text, and
  `sourceHash` = hash of the code text (not the JSON).
- The top-level unit's `id` is the node ID (path without `.json`) with
  `identity: 'durable'`. Its `annotation` is
  `{ intent, contract, dependencies: context, examples, locked }`. Child units
  (methods) keep hashed IDs.
- Unit ranges are relative to the code text. The host's `sources` map holds
  that text keyed by document path, which is what generation and search
  slice.
- In the webview, `node.data.path` is the node ID in folder mode (a file path
  in legacy mode). Use `nodeIdOf(document.path)` to match.

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
npx playwright test                    # webview with fake host (~3s); uses ?demo
npm run test:electron                  # Extension Host (~45s); builds + compiles first
npm run verify:baseline                # CI gate incl. legacy tests/build + example pytest
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
`declare module '*.css';`. The baseline is **12 pre-existing errors** in
`main.tsx`'s message handler (narrowing inside closures). Don't add new ones.

Visual checks: start `npx vite --port 5199`, then use a Playwright script that
stubs `window.acquireVsCodeApi` (record `postMessage` calls in
`window.__messages`). Load `/harness.html?demo=folder`, screenshot into
`.amp/in/artifacts/`, and inspect with `view_media`, passing an objective
that states the expected result.

## Learnings and gotchas

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
  and `.cm-editor` targets (CodeMirror).
- The default CodeMirror highlight is unreadable on dark backgrounds; use the
  `HighlightStyle` defined in `main.tsx`.
- Don't call `selectFromEditor` after every refresh in folder mode. It snaps
  the canvas selection back to whatever editor was last active.
- Legacy calculator/tic-tac-toe annotations (`## @slate id=… prompt:`) are
  not the current grammar. Phase 2 ports their Python from
  `legacy/examples/`; don't hand-convert them.
- The owner's worktree may contain their own changes (e.g. an unstaged
  `dev_notes.md` deletion, untracked `slate.slate.json` and
  `vscode-extension/vscode_extension.slate.json`). Never stage or revert
  them.
- Cost: the first thread spent about $13 on audit, cleanup, planning, and
  Phase 1a. Keep later threads focused on one phase.

## Phase 1 — `slate/` folder and a calm canvas

**Done (1a, 2026-10-13):** S-100–S-103 (format, loader, folder canvas, node
creation/editing, New Project, demo).

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

## Phase 2 — port and compile (next thread)

Read first: `slate_folder.ts`, `python_adapter.ts` (`parseDetailed`),
`legacy/examples/calculator/*.py` and their `tests/`, plus
`legacy/examples/tic_tac_toe/`.

### S-200 Importer (`vscode-extension/src/port/python_importer.ts`, pure)

- Input: `Map<relativePath, source>`. Output:
  `{ nodes: Map<nodeId, SlateNode>, report: PortReport }`.
- Each module `a/b.py` maps to folder `a/b/`. Each top-level def or class
  becomes `a/b/<name>.json` (name == stem).
- **Imports.** Parse the module's import statements. Each node gets only the
  imports whose bound names appear as identifiers in its code (walk Lezer
  `VariableName` nodes). Imports of other *ported* modules' definitions are
  dropped and recorded as `uses` (node IDs).
- **New optional field `uses: string[]`** (node IDs). Compile resolves bare
  names same-folder first, then via `uses`, then a unique global match.
  Ambiguity is a diagnostic. Add the field to `slate_folder.ts` (parse,
  serialize, preserve).
- **Module-level state** (assignments, constants, `if __name__ == ...`,
  side-effect statements) goes into `a/b/_prelude.json` with
  `"kind": "prelude"` (exempt from the name == stem and single-definition
  rules; `code` holds the statements). Compile emits it right after imports.
  The canvas shows it as a small "module state" node.
- **Report:** counts, preludes created, warnings (star imports, conditional
  or dynamic definitions, `global` usage, name collisions).
- **Host command** `slate.portProject`: pick a source folder and write
  `slate/` into the workspace with fs writes. Refuse if `slate/nodes` is
  non-empty. Show the report in an output channel. Never modify the source
  project.

### S-201 Describe pass (`port/describe.ts` packet + host loop)

- Order: topological over `uses` (leaves first); break cycles by node ID.
- Packet: an instruction ("Describe what this function does. Reply with
  exactly `intent: <one line>` and optionally `contract: <one line>`."), the
  node code, and for each used node only `signature + intent`. Budget: about
  600 input and 120 output tokens.
- Parse: accept the `intent:` and optional `contract:` lines; reject anything
  multi-line or over 240 characters (retry once, then skip and report).
- Write `intent`, `contract`, and `describedBy: "llama"`. Skip nodes that
  already have an intent, which makes runs resumable. Report progress via
  status messages; support cancel.
- Tests with `test/support/fake_llama_server.ts`: ordering, skip/resume,
  malformed reply, timeout, cancel.

### S-202 Compile (`compile/python.ts`, pure; host command `slate.compile`)

- Output `Map<relativePath, text>` under `config.compile.outDir`. Each folder
  becomes a module (`a/b/` → `<outDir>/a/b.py`, plus `__init__.py` files).
  Root-level nodes go into `<outDir>/__init__.py`, and root nodes may not
  use subfolder nodes (diagnostic), which avoids import cycles.
- Module text: generated header → `from __future__` imports → merged,
  deduplicated external imports (first-seen order) → relative imports for
  cross-module node references (`from .operations import add`) → prelude →
  nodes in `order` (an importer-assigned index, else node ID). Each block is
  preceded by `# slate: nodes/<id>` and `# intent: …`.
- **Acceptance:** port `legacy/examples/calculator` and `tic_tac_toe`,
  compile them, and run their pytest suites against the output (the suites
  read `SLATE_CALCULATOR_DIR` / `SLATE_TIC_TAC_TOE_FILE`; check how
  `scripts/verify-baseline.sh` sets them). Golden tests cover import
  rewriting, collisions, and preludes.
- Wire it into `verify:baseline` as the new port → compile → pytest gate.

### S-203 Retire project-v2 mode

Delete `project_v2.ts`, `contracts/project-v2.schema.json`, adapter
`adoptUnit` / `updateAnnotation` / `insertStub` and `## @slate` parsing,
the `scanWorkspace` command, legacy branches in `harness_panel.ts`,
`buildSourceMapNodes`, and `?demo` (move Playwright to `?demo=folder`). Update
the Extension Host tests and fixtures. `HarnessPanel.createOrShow` without a
`slate/` folder should offer **New Project** / **Port Python Project…**.

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
