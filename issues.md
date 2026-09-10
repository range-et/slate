---
tags: [project, slate, harness, issues, python, xyflow]
status: open
---

# Slate Python harness — implementation tasks

The governing plan and manual gates are in
[SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md). This file contains only active
work. The previous v0.2 backlog was superseded by the source-first Python port;
its shipped results remain recorded in [features.md](features.md).

The port was approved on 2026-09-10. Complete tasks in dependency order. Every
task must leave all earlier automated gates green.

## Breakpoint 0 — baseline

### H-002 Freeze versioned contracts
- **Scope:** Define v2 project JSON, annotation, source-position, worker RPC,
  and webview↔host message schemas. Include migration fixtures for current JSON
  and `## @slate` files.
- **Acceptance:** Schemas have strict TypeScript/Python validation and fixtures;
  unknown annotation fields survive; unsupported versions block writes.
- **Blocks:** H-003, H-006, H-009.

## Breakpoint 1 — Python engine

### H-003 Create the supervised LibCST worker
- **Scope:** Add a Python package exposing newline-delimited JSON RPC over
  stdio. Implement health, parse-module, and shutdown operations. The worker
  accepts source snapshots and never accesses workspace files directly.
- **Acceptance:** Extension starts, monitors, restarts, and stops the worker;
  malformed requests cannot crash the extension; clean-install setup is
  documented and tested.
- **Depends:** H-002.
- **Blocks:** H-004, H-005, H-010.

### H-004 Build lossless Python indexing
- **Scope:** Extract modules, classes, functions, methods, nested declarations,
  decorators, async state, signatures, annotations, IDs, intent blocks, and
  precise ranges using LibCST metadata.
- **Acceptance:** No-op processing changes zero bytes across golden fixtures;
  Unicode, tabs, CRLF, multiline signatures/strings, empty modules, scripts,
  and malformed snapshots have explicit tests.
- **Depends:** H-003.
- **Blocks:** H-007, H-011.

### H-005 Build minimal structural patching
- **Scope:** Add operations for adopting a unit ID, changing intent/contract,
  inserting a typed stub, and replacing one function/method body. Reparse the
  candidate module and prove edits stay inside permitted regions.
- **Acceptance:** Property/golden tests show unrelated text and locked units are
  byte-identical; stale hashes, ambiguous ownership, duplicate IDs, invalid
  syntax, and out-of-range edits are rejected.
- **Depends:** H-003, H-004.
- **Blocks:** H-011, H-012, H-017.

### H-006 Establish Python validation tooling
- **Scope:** Add isolated worker dependencies and project-aware adapters for
  Ruff, Basedpyright strict mode, pytest, and Python syntax checking.
- **Acceptance:** Candidate snapshots can be validated without first writing
  them over user source; diagnostics map to document/node IDs; project configs
  are honored rather than rewritten.
- **Depends:** H-002.
- **Blocks:** H-012, H-017.

## Breakpoint 2 — one XYFlow source browser

### H-007 Create the React + TypeScript webview
- **Scope:** Add a new Vite React entry using `@xyflow/react`, plain typed domain
  records, design tokens, and one canvas. Do not mount it through the legacy
  `MainManager`.
- **Acceptance:** Files/classes/functions/methods render with containment,
  explicit-context, and inferred-reference edges; pan/zoom/fit, stable layout,
  class collapse, and multi-select are covered by component tests.
- **Depends:** H-004.
- **Blocks:** H-008, H-013, H-019.

### H-008 Add inspector, command bar, and status surfaces
- **Scope:** Contextual node inspector plus compact deterministic commands:
  `find`, `reveal`, `stub`, `intent`, `generate`, `queue`, `accept`, `skip`,
  `lock`, `cancel`, and `fit`. Show dirty, stale, parse, validation, and conflict
  states without adding separate card/document screens.
- **Acceptance:** All commands target IDs rather than labels; keyboard and
  accessible controls work; no language or model picker appears.
- **Depends:** H-007.
- **Blocks:** H-013, H-018.

### H-009 Replace whole-state custom-editor synchronization
- **Scope:** Make the extension host the sole mutation coordinator. Track exact
  project roots, open document versions, source hashes, dirty buffers, file
  creates/deletes, and external edits. Replace boolean echo suppression with
  revision comparison.
- **Acceptance:** Dirty buffers beat disk; async stale parse results are
  discarded; invalid source retains a visibly stale last-good graph; indexing
  never writes source.
- **Depends:** H-002, H-003.
- **Blocks:** H-010, H-011, H-014.

### H-010 Implement bidirectional editor navigation
- **Scope:** Graph selection reveals and selects the current exact source range;
  editor selection highlights the deepest containing graph node.
- **Acceptance:** Works for top-level functions, decorated methods, classes,
  Unicode, dirty buffers, and moved ranges without focus-stealing loops.
- **Depends:** H-004, H-007, H-009.

## Breakpoint 3 — typed stub round trip

### H-011 Implement graph↔source typed stubs
- **Scope:** From XYFlow, create functions and methods with typed signatures,
  intent, contract, input/output examples, dependencies, locks, and
  `NotImplementedError` bodies. Source edits must update those graph fields.
- **Acceptance:** Top-level, async, decorated, and method stubs import cleanly;
  calls fail loudly; graph edits preview exact patches and use WorkspaceEdit;
  VS Code undo restores graph state.
- **Depends:** H-005, H-008, H-009.
- **Blocks:** H-012, H-015.

### H-012 Enforce strict stub contracts
- **Scope:** Surface missing parameter/return annotations, incompatible
  dependency types, example mismatches, Ruff findings, Basedpyright findings,
  and targeted pytest results on nodes.
- **Acceptance:** Plausible wrong signatures fail tests; failure blocks default
  acceptance but preserves editable work; project-specific validation commands
  can be configured in JSON/settings.
- **Depends:** H-006, H-011.

### H-013 Migrate current projects and annotations
- **Scope:** Read current Project→Documents→Cards JSON and v1 annotation blocks,
  preserving IDs/prompts where correspondence is unambiguous. Never overwrite
  source during migration.
- **Acceptance:** Calculator and tic-tac-toe open in the new graph; ambiguous or
  missing mappings produce repair tasks rather than title-based destructive
  guesses.
- **Depends:** H-002, H-007, H-011.

## Breakpoint 4 — one-card local generation

### H-014 Move Ollama transport into the extension
- **Scope:** Configure endpoint, model, context budget, timeout, and validation
  commands through VS Code settings. Add health diagnostics, streaming, and
  cancellation. Remove primary-flow provider/model selection and silent cloud
  fallback.
- **Acceptance:** Deterministic fake transport tests and real Ollama smoke test
  pass; unavailable/cancelled/timed-out requests do not mutate source.
- **Depends:** H-009.
- **Blocks:** H-016.

### H-015 Build bounded context packets
- **Scope:** Include only unit contract/signature, necessary enclosing context,
  direct explicit dependencies, relevant test contracts, and bounded revision
  feedback. Expose a manifest and per-part size before generation.
- **Acceptance:** Token and 100–200-source-line ceilings are enforced; oversized
  units suggest decomposition; hidden whole-repository context is impossible.
- **Depends:** H-011.
- **Blocks:** H-016.

### H-016 Generate and review one proposal
- **Scope:** Stream candidate code, validate it, display the complete diff and
  diagnostics, then support accept/edit/regenerate/cancel. Preserve signatures
  and decorators by default.
- **Acceptance:** Model output cannot select paths/ranges; stale source or
  dependency revisions invalidate acceptance; valid acceptance is one undoable
  WorkspaceEdit affecting only reviewed hunks.
- **Depends:** H-005, H-006, H-008, H-014, H-015.
- **Blocks:** H-018.

## Breakpoint 5 — Generate All and subgraph queue

### H-017 Implement dependency and eligibility engine
- **Scope:** Model separate containment, explicit context, and inferred
  reference edges. Compute eligible stubs and deterministic leaves-first order.
- **Acceptance:** Unit tests cover disconnected graphs, diamonds, cycles,
  locked/accepted/blocked/oversized nodes, methods, and source-order tie breaks.
- **Depends:** H-005, H-006, H-011.
- **Blocks:** H-018.

### H-018 Preserve and harden Generate All
- **Scope:** Queue eligible stubs for the whole project, selection, or selected
  dependency subgraph. Pause per proposal for accept/edit/regenerate/skip/lock/
  cancel. Persist and resume queue state.
- **Acceptance:** One failure does not erase the queue; accepted/locked cards are
  never regenerated implicitly; upstream edits stale dependent proposals;
  calculator and tic-tac-toe complete through a deterministic fake model and
  pass strict validation/tests.
- **Depends:** H-008, H-016, H-017.

## Breakpoint 6 — retirement and release

### H-019 Retire the legacy application
- **Scope:** Once H-018 passes its gate, make the React XYFlow application the
  only extension UI. Remove D3, the three-panel HTML, cards/chat applets,
  compile/rehydrate reconstruction, and cloud-provider UI except code required
  for explicit migration.
- **Acceptance:** No legacy runtime route ships; no replacement invariant loses
  its existing test; extension bundle contains one graph application.
- **Depends:** H-007, H-013, H-018.

### H-020 Replace GitHub Pages with a static product site
- **Scope:** Build a static feature page containing product explanation,
  workflow, extension installation, local-model requirements, and inspected
  screenshots. It does not open projects, edit source, or call models.
- **Acceptance:** Fast static build deploys under the current Pages workflow;
  no editor code or API-key surface ships in the site bundle.
- **Depends:** H-019 for final screenshots; page shell may start earlier.

### H-021 Package and release-candidate hardening
- **Scope:** Clean-profile VSIX installation, Python worker provisioning,
  restart recovery, telemetry-free diagnostics, migration stress tests, and
  full CI across supported Python/VS Code versions.
- **Acceptance:** Every breakpoint's automated and manual gate passes; a user
  can complete folder→stub→Generate All→accept→strict checks after restart.
- **Depends:** H-018, H-019, H-020.

## Deferred

- Markdown transformation nodes and summary convergence.
- Other programming languages.
- Autonomous shell/tool execution.
- Browser folder editing or browser Ollama support.
- Automatic stale-proposal rebasing and arbitrary cross-file refactors.

When a task ships, move its block to [features.md](features.md) with a resolved
date and commit link. Do not leave completed work in this file.
