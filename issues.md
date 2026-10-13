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

## Phase 5 — linked building blocks and trustworthy editing

### S-500 One occurrence model
- Every use is an instance pointing at a definition; root refs become
  `main.json` instances and layout keeps placement only. Migrate existing
  projects without breaking wires.

### S-501 Copy as linked / copy as duplicate
- Cmd+C, **Paste linked** (Cmd+V, default), **Paste duplicate**
  (Cmd+Shift+V), and **Make unique**. Duplicates get fresh node files and
  keep their dependencies linked; a duplicated flow forks its wiring only.

### S-502 Used by N and shared-edit awareness
- Derived usage index (instances + compiler-resolved code dependencies;
  context listed separately), navigable call sites, "affects N uses" banner
  with Fork.

### S-503 Undoable structural edits, flow ports, deletion
- Wires, flows, copies, forks, grouping, port rename/remove, and deletion as
  one undoable `WorkspaceEdit` each; remove-use vs delete-definition with an
  impact preview.

### S-504 Node health report and canvas fixes
- Read-only unused / exact-duplicate / near-duplicate report with coverage
  caveats. Docked Inspector; type-mismatch warnings; context links on demand.

## Phase 6 — live execution with executable cases

### S-600 Trusted runner on the real compiler
- Run/Stop for a chosen flow via compile + trace into `.slate/build/<run>/`;
  limits, Stop, separate protocol/stdout; refuse invalid or stale graphs;
  values keyed per use (invocation path + instance + port).

### S-601 Values, inputs, viewers
- Structured JSON value literals (migrating Python-expression strings),
  editable inputs, wire previews, pinned viewers, failures and "not executed"
  downstream.

### S-602 Cases as guardrails
- Structured `cases` on nodes and flows; capture-to-case from a viewer; run
  cases on edits; show shared-node and affected-flow cases while editing.

### S-603 Live mode
- Opt-in Live reruns the chosen flow after committed edits; explicit
  side-effect consent; no purity caching.

## Phase 7 — a small local helper with guardrails

### S-700 Occurrence-aware micro packets
- Target + bounded neighbors (signature + intent) + context summaries +
  selected cases; exact packet view; refuse oversized targets. Absorbs H-027.

### S-701 Verified candidates and revision loop
- Scratch-overlay compile and case runs, candidate edit, regenerate with
  feedback, explicit "try up to three revisions", llama.cpp health; acceptance
  bound to all packet inputs. Typed stubs from add-node search / wire drop.
  Absorbs H-028.

## Phase 8 — explicit control flow

### S-800 Branch, foreach, repeat regions
- Regions reusing child flows as bodies, compiled to `if`/`for`, only the
  chosen branch runs, bounded repeat, iteration inspection.

## Phase 9 — TypeScript and staged self-hosting

### S-900 Adapter boundary and TS/TSX adapter
- Index, ports, stubs, validation, prompts, imports, and compile behind one
  boundary; TS/TSX modules with paths and extensions preserved.

### S-901 Methods as nodes; staged self-hosting gate
- Class methods as owned node files; React closures stay in components. Gate:
  pure TS → extension class → TSX component → full rebuild. Compile never
  overwrites files it did not generate.

## Deferred

- Generate-all as "fill placeholders in topological order" (was H-030).
- Reverse codegen: import a straight-line function as a flow.
- Comprehension optimization for zones; automatic deduplication.
- Out of scope (not deferred): cloud providers and autonomous model tools.
