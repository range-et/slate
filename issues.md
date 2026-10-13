# Slate — active backlog

Ordered by phase from [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md). Shipped
work moves to [features.md](features.md). Old H-0xx items are folded in where
noted.

## Phase 0 — cleanup

### S-001 Delete `legacy/` once the harness can replace the site
- **Done 2026-10-13:** the notebook is isolated in `legacy/`; Pages deploys
  `legacy/dist`; the root build and extension are harness-only.
- **Remaining:** when Phases 1–5 land, replace the Pages output with a static
  product page, `rm -rf legacy/`, drop the `legacy:*` scripts and the legacy
  block in `scripts/verify-baseline.sh`, and remove legacy-only dependencies
  (`openai`, `@google/genai`, `d3`, `marked`, `uuid`; CodeMirror packages if
  still unused). Absorbs H-031.

## Phase 1 — `slate/` folder and a calm canvas

Phase 1 (S-100 to S-111) shipped on 2026-10-13; see [features.md](features.md).

## Phase 2 — port and compile

Phase 2 (S-200 to S-203) shipped on 2026-10-13; see [features.md](features.md).

## Phase 3 — one workspace

### S-300 Library sidebar
- `slate/nodes` folders plus read-only library code, searchable. Dragging an
  item to the canvas creates a reference.

### S-301 Reference nodes
- Stored in layout.json as `{ id, target, position }`, many per target. Menu:
  Go to definition, Find references, Select definition, Generate body.
  Missing targets render as broken.

### S-302 Placeholders → node files
- A name-only note resolves to a reference if the node exists; otherwise
  **Create node** proposes a new node JSON, with its signature from wires or
  a small form.

### S-303 Compose / Map toggle
- Map groups nodes by folder (output module); Compose is free. Selection is
  shared between them.

## Phase 4 — ports, wires, flows

### S-400 Typed ports
- Ports come from parameters and return annotations, colored by type, with
  "any" for untyped. Context ports are visually separate.

### S-401 Data wires and add-node search
- Port-to-port wires; Tab, double-click, or Shift+A opens add-node search;
  dragging into empty space opens it filtered by type and auto-wires.

### S-402 Flows
- Ctrl+G saves the selection as `slate/flows/<name>.json` with Group
  Input/Output. Compile generates the flow function deterministically. Tab
  enters a flow; breadcrumbs exit.
- **Acceptance:** codegen golden tests (fan-out, multiple outputs, unused
  inputs, name collisions); the compiled flow runs under pytest.

## Phase 5 — live values

### S-500 Trusted Python runner
- The host materializes nodes into `.slate/build/`, spawns the workspace
  interpreter,
  evaluates the active flow topologically, and returns truncated reprs per
  wire and errors per node. Timeout and cancel; trusted workspaces with Live
  on only.

### S-501 Input, Viewer, Example nodes; auto-solve; mute
- Inputs, viewers, `example:` seeding, Ctrl+Shift+click viewer, debounced
  re-run, M to mute.

## Phase 6 — local model inside the graph

### S-600 Graph-derived packets and examples as oracle
- Packet = signature + intent + wired neighbors + context + example values.
  Candidates run against examples before review; iterate until they pass, up
  to 3 attempts; edit/regenerate; llama.cpp health indicator. Optional
  trusted Ruff/Basedpyright. Absorbs H-027 and H-028.

## Phase 7 — zones

### S-700 For-each, repeat, branch zones
- Canvas frames that compile to a comprehension/`for`, a state-carrying loop,
  and `if`; the runner shows per-iteration values.

## Deferred

- Generate-all as "fill placeholders in topological order" (was H-030).
- Reverse codegen: import a straight-line function as a flow.
- Methods/classes as compose nodes; other languages; autonomous model tools;
  cloud providers.
