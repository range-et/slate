# Slate Plan — a node canvas for composing Python

Status: active — revised 2026-10-13. Replaces the 2026-09-23 "source-first
harness" plan, whose safety contract is kept below. Shipped work is in
[features.md](features.md); tasks are in [issues.md](issues.md).

## North star

One large canvas per project where Python functions are nodes with typed
ports, wires carry values, and you compose freely — the way Grasshopper,
Blender Geometry/Shader Nodes, or Unreal Blueprints feel. You (or a local
llama.cpp model) write the small leaf functions; you wire them together by
hand; groups of wired nodes become real Python functions; values flow through
the graph live so you can see what every node does.

The local model is a helper for writing one node's body. It is never the
driver.

## Why it does not click today

Audit of the shipped harness (2026-10-13). The problems are structural, not
polish.

1. **The canvas is a file browser, not a composition surface.** Nodes are laid
   out as files → classes → functions and are clamped inside their parent
   container (`extent: 'parent'` in `src/harness/graph.ts`). You can't put two
   functions from different files next to each other, so there is no "one
   large workspace."
2. **Ports are fake.** Every node draws input/output handles, but
   `nodesConnectable={false}`. The core gesture of every node tool — drag a
   wire — does nothing.
3. **The only wire means "include in the LLM prompt."** Context edges
   (`depends-on`) are prompt plumbing, not dataflow. There is no way to
   express "the output of A feeds B."
4. **Code lives off-canvas.** Every single click opens the source in a side
   editor, so clicking to drag or inspect moves your editor. The node shows
   only a signature, and the inspector is a form with separate Save buttons.
5. **Two competing input languages.** An uppercase CAD command line with `::`
   separators (`STUB file.py :: def f(x: int) -> int :: intent`) next to mouse
   menus. Any printable key typed on the canvas is hijacked into that command
   line. Context is picked from a `<select>` dropdown.
6. **No creation gesture.** You can't double-click or Tab on the canvas to add
   a node, and can't drag from a port to create the next one. Creating a
   function means typing a `STUB` command.
7. **Nothing runs.** Grasshopper and Geometry Nodes work because you change
   an input and see every downstream value update. Slate never executes code,
   so the graph never shows behavior.
8. **Notes are dead text.** They can't stand in for a function, jump to it,
   or become one.
9. **The canvas fights you.** Every drag rewrites and saves the whole
   `.slate.json`, which triggers a re-index, a new revision, and a full graph
   rebuild. Every keystroke in any Python file bumps the revision, so commands
   issued meanwhile fail with "graph changed; run the command again."
10. **The examples don't use the current grammar.** Calculator and tic-tac-toe
    still use the legacy annotation format, so they show up as provisional,
    intent-less nodes. Slate also can't map its own TypeScript code, so
    dogfooding it on this repo shows nothing useful.
11. **The previous plan ruled this direction out.** It said "the graph is not
    the product," deferred call graphs, and gated further work on a week-long
    pilot. The interaction feels off because the product was steered away
    from composition.

## Core model

### Ownership (what is the source of truth)

| Thing | Owned by |
| --- | --- |
| Leaf function body, signature, `## @slate` annotation | Python source (unchanged) |
| Composite ("flow") wiring | `.slate.json` canvas; Slate **generates** the Python body |
| Reference nodes, placeholders, notes, layout, frames | `.slate.json` canvas |
| Live values | Runtime only, never persisted |

A flow's generated body carries `## @slate … kind=flow graph=<hash>`. If
someone hand-edits that body, Slate marks the flow **detached** and never
overwrites it silently. Re-sync or convert to a leaf are explicit actions.

### Node kinds

```diagram
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Function     │  │ Reference    │  │ Placeholder  │  │ Flow (group) │
│ the real def │  │ alias of a   │  │ name only,   │  │ wired subgr. │
│ ports from   │  │ function;    │  │ dashed; can  │  │ → generated  │
│ signature    │  │ many allowed │  │ become stub  │  │ Python def   │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Input        │  │ Viewer       │  │ Zone         │  │ Note         │
│ number/text/ │  │ shows value  │  │ repeat /     │  │ free text    │
│ list/example │  │ on a wire    │  │ for-each /if │  │ (existing)   │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

- **Ports** come from the signature the adapter already extracts
  (`parameters`, `returnAnnotation`). Inputs on the left, return on the right,
  colored by type annotation; untyped is grey "any". Mismatches are warned,
  not blocked.
- **Reference nodes** are what you asked for as reference notes: a compact
  pill showing a function's name and ports that can sit anywhere, as many
  times as you like. Right-click → Go to definition, Find references, Select
  definition node, Generate body.
- **Placeholders** are shortform notes: type a name (and optionally a
  signature). If the name resolves, the placeholder becomes a reference. If it
  doesn't, right-click → **Create stub** writes a typed stub, with its
  signature inferred from the wires attached to it.
- **Flows** are Blender node groups / Grasshopper clusters: select nodes,
  Ctrl+G, name it. Tab enters; breadcrumbs exit. Group Input/Output nodes
  define the signature.
- **Zones** cover loops: for-each compiles to a list comprehension or `for`,
  repeat carries state N times, branch compiles to `if`.

### Two views of one project

- **Compose** (default): the free canvas above. Files are not containers.
- **Map**: the existing file → class → function layout, kept for orientation.
  The same file tree also lives in a **Library** sidebar; drag from it to the
  canvas to drop a reference.

### Interaction grammar (one way to do each thing)

| Gesture | Effect |
| --- | --- |
| Click | Select only; no editor jump |
| Double-click node | Expand inline code (CodeMirror on the node) |
| F12 / Cmd-click / menu | Go to definition in the side editor |
| Double-click canvas, Tab, Shift+A | Add-node search at the cursor |
| Drag port → port | Wire |
| Drag port → empty space | Add-node search filtered by type, auto-wire |
| Ctrl+Shift+click | Attach a viewer to this node's output |
| Ctrl+G / Tab / Esc | Group into flow / enter / exit |
| M / H | Mute (bypass) / collapse |
| Cmd+K | Command palette (replaces the uppercase command line) |
| Right-click | Context menu; every menu item is also in Cmd+K |

Every gesture dispatches the same typed action. Typed actions are never
converted to command strings and re-parsed.

### Live evaluation

In a trusted workspace, with **Live** toggled on, the extension host runs a
small runner in the workspace's Python interpreter. The runner imports the
user's modules, evaluates the active flow in topological order, and returns a
truncated `repr` for every wire plus exceptions per node. Changes are
debounced and every run has a timeout. Inputs come from Input nodes or
`## example:` annotations. This is the Grasshopper moment, and it also gives
the local model an oracle.

### The local model's role

"Generate body" on a function or placeholder builds a packet automatically
from what the canvas already knows: the signature (from ports), intent, wired
upstream/downstream neighbors, explicit context, and example values flowing
in. The candidate is run against the examples **before** review. A bounded
"iterate until examples pass" loop (at most 3 attempts) shows every attempt.
Confinement, review, accept, and undo stay as shipped.

## Safety contract (kept from the previous plan)

1. Python files and dirty buffers are authoritative for leaf code.
2. The extension host owns filesystem access, indexing, the runner, llama.cpp
   transport, proposals, and final `WorkspaceEdit` application. The webview
   sends typed intent only.
3. Every source mutation — stub, annotation, generated leaf, generated flow
   body — is a host-owned proposal bound to the target unit's hash, previewable,
   applied as one `WorkspaceEdit`, and undoable.
4. Staleness is checked per affected unit, not per global revision, so typing
   elsewhere never invalidates an action.
5. Code runs only in trusted workspaces, only when Live is on, and only with a
   timeout. There is no cloud fallback.

## Phases

Each phase has a "you can feel it" exit test. Dogfood every phase on a real
project instead of gating on a separate week-long pilot.

### Phase 0 — cleanup and decision (started 2026-10-13)

Removed the dead LibCST engine and its contract. Moved the legacy browser
notebook, its tests, fixtures, and docs into `legacy/`. GitHub Pages keeps
deploying it from there; delete the folder once the harness can replace the
site (S-001).

### Phase 1 — stop the friction (no new concepts)

Click selects only. Remove keystroke hijacking. Replace the command line with
Cmd+K. Delete the action→string→parse round-trip. Use a single shared protocol
type file. Free nodes from file containers. Debounce layout writes and skip
re-indexing on layout-only changes. Check staleness per unit. Inline intent
editing on the node. A searchable context picker, plus drag-a-wire to add
context. Convert the examples to v2 annotations.
**Exit:** an hour in the canvas without fighting it.

### Phase 2 — one workspace: references, placeholders, library

Library sidebar, reference nodes, placeholders → stubs, find references,
Compose/Map toggle.
**Exit:** describe a function once, drop it anywhere, jump to it from anywhere.

### Phase 3 — ports and wires

Typed ports, port-to-port wires, add-node search from canvas and ports,
Ctrl+G flows with deterministic Python codegen, Tab into flows, detached-flow
detection.
**Exit:** build a four-node pipeline from existing functions without typing
Python and get a real Python function out.

### Phase 4 — live values

Input/Viewer/Example nodes, trusted runner, per-wire previews, per-node
errors, mute/bypass, auto-solve.
**Exit:** change a number and every downstream value updates in under a
second.

### Phase 5 — local model writes leaves inside the graph

Generate from the graph-derived packet, run examples before review, bounded
iterate-until-pass, llama.cpp health indicator, edit/regenerate candidates.
**Exit:** sketch a placeholder between two wired nodes, generate it, watch it
pass its examples, accept, undo.

### Phase 6 — zones and control flow

For-each, repeat, and branch zones compile to Python.
**Exit:** the tic-tac-toe game loop is expressible as a flow.

### Later

Ruff/Basedpyright validation; generate-all as "fill every placeholder in a
flow in topological order"; importing an existing straight-line function as a
flow (reverse codegen); rename across references; methods and classes as
first-class compose nodes; other languages.

## Open questions

- **Where generated flow functions live.** Recommended: a module the user
  picks, defaulting to `flows.py` next to the project file.
- **Interpreter selection.** Use the Python extension's active interpreter
  when present, or a `slate.python.path` setting otherwise.
- **Methods/classes in Compose.** Start with free functions; add `self` ports
  and constructors in Later.
- **Host.** Stay in VS Code (files, undo, interpreter, editor) but give the
  canvas the full editor area. Revisit a standalone app only if the webview
  limits interaction.
