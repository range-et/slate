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

Phase 3 (S-300 to S-303) shipped on 2026-10-13; see [features.md](features.md).

## Phase 4 — ports, wires, flows

Phase 4 (S-400 to S-402) shipped on 2026-10-13; see [features.md](features.md).

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
