# Slate — active backlog

Ordered by phase from [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md). Shipped
work moves to [features.md](features.md). Old H-0xx items are folded in where
noted.

## Phase 0 — cleanup

### S-001 Delete `legacy/` once the harness can replace the site
- **Done 2026-10-13:** the notebook is isolated in `legacy/`; Pages deploys
  `legacy/dist`; the root build and extension are harness-only.
- **Remaining scope:** when Phases 1–4 land, replace the Pages output with a
  static product page (current screenshots, install + llama.cpp setup), then
  `rm -rf legacy/`, drop the `legacy:*` scripts and the legacy block in
  `scripts/verify-baseline.sh`, and remove the legacy-only dependencies
  (`openai`, `@google/genai`, `d3`, `marked`, `codemirror`, `uuid`, CodeMirror
  language packs if unused).
- **Acceptance:** `npm run test:harness` passes; clean-profile VSIX completes
  search → generate → accept → undo after restart.
- Absorbs H-031.

## Phase 1 — stop the friction

### S-010 Selection without side effects
- Click selects only. F12, Cmd-click, or the menu reveals source. Double-click
  expands inline code (S-014). Remove the global keystroke → command-line
  hijack.

### S-011 Cmd+K palette replaces the CAD command line
- One fuzzy palette listing every typed action and target. Delete
  `src/harness/commands.ts`'s uppercase/`::` grammar and the host's
  `handleAction → handleCommand` string round-trip; the host switches on typed
  actions directly.
- Webview imports protocol types from one shared file instead of duplicating
  `harness_protocol.ts` in `src/harness/types.ts`.

### S-012 Free canvas and calm persistence
- Drop `extent: 'parent'`; files and classes become optional collapsible
  frames.
- Debounce layout writes. Layout-only project edits must not trigger
  re-indexing or a revision bump.
- Staleness is checked per target unit hash, not per global revision.

### S-013 Context by wire and by search
- Drag from a node's context port to another node to add `depends-on`. A
  searchable popup (also used by `@` in intent fields and the node menu)
  replaces the `<select>`.
- Annotation, chip, edge, and packet stay in agreement. Absorbs H-026.

### S-014 Inline node editing
- Intent and contract are edited on the node and save on blur. Expanding a
  node shows its code in CodeMirror, read-only first.

### S-015 Bring the examples into the v2 grammar
- Copy calculator and tic-tac-toe Python from `legacy/examples/` into
  `examples/` with `## @slate v=2 … ## @slate-end` annotations, project-v2
  files, and their pytest suites, so they open fully durable in the harness.

## Phase 2 — one workspace

### S-020 Library sidebar
- File → class → function outline with search; dragging onto the canvas
  creates a reference node.

### S-021 Reference nodes
- Persisted in `.slate.json` as `{ id, targetId, position }`. Multiple per
  target. Menu items: Go to definition, Find references (highlight all),
  Select definition, Generate body. Deleting a reference never touches source.
- Missing targets render as broken, not deleted.

### S-022 Placeholder notes → stubs
- A name-only note resolves to a reference when the name matches a durable
  unit. Otherwise **Create stub** proposes a typed stub (signature from
  attached wires or a small form) through the normal proposal flow.

### S-023 Compose / Map toggle
- Compose is the free canvas; Map is today's containment layout. Selection is
  shared between them.

## Phase 3 — ports and wires

### S-030 Typed ports
- Ports come from `parameters` / `returnAnnotation`, colored by type. Untyped
  ports are "any." Context ports are visually separate from data ports.

### S-031 Data wires and add-node search
- Port-to-port wires in Compose are persisted in `.slate.json`. Tab,
  double-click, or Shift+A opens add-node search at the cursor; dragging into
  empty space opens it filtered by type and auto-wires.

### S-032 Flows (group → Python)
- Ctrl+G turns a selection into a flow with Group Input/Output nodes.
  Deterministic codegen produces a Python function body, written via a
  proposal with a `kind=flow graph=<hash>` annotation. Tab enters a flow,
  breadcrumbs exit.
- Hand-edited flow bodies are detected as detached and never silently
  overwritten.
- **Acceptance:** golden tests for codegen (fan-out, multiple outputs,
  unused inputs, name collisions); round-trip through apply + undo in the
  Extension Host suite.

## Phase 4 — live values

### S-040 Trusted Python runner
- The host spawns the workspace interpreter with a bundled runner script. It
  evaluates the active flow topologically and returns truncated reprs per wire
  and errors per node, with a timeout and cancellation. It runs only in
  trusted workspaces with Live on.

### S-041 Input, Viewer, Example nodes
- Number/Text/Bool/List inputs; Viewer shows the wire value; `## example:`
  annotations seed inputs. Ctrl+Shift+click attaches a viewer.

### S-042 Auto-solve and mute
- Debounced re-run on source or wiring change; M mutes (bypasses) a node;
  errors render on the failing node.

## Phase 5 — local model inside the graph

### S-050 Graph-derived packets
- Packet = signature + intent + wired neighbors + explicit context + example
  values. Generation is allowed for placeholders and provisional units (the
  annotation is adopted in the same proposal).

### S-051 Examples as the oracle
- Candidates run against examples before review. Iterate until they pass, up
  to 3 attempts, showing every attempt. Edit and regenerate candidates.
  Absorbs H-027's remaining items.

### S-052 llama.cpp health and validation
- Endpoint health indicator. Optional trusted Ruff/Basedpyright/pytest on
  candidate snapshots. Absorbs H-028's remaining items.

## Phase 6 — zones

### S-060 For-each, repeat, branch zones
- Frames on the canvas that compile to a comprehension/`for`, a state-carrying
  loop, and `if`. The runner shows per-iteration values for the first N
  iterations.

## Deferred

- Generate-all / queue as "fill placeholders in topological order" (was
  H-030).
- Reverse codegen: import a straight-line function as a flow.
- Rename across references; methods/classes as compose nodes.
- Additional languages; autonomous model tools; cloud providers.
