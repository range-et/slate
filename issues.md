---
tags: [project, slate, harness, issues]
status: open
---

# Slate harness — active implementation backlog

Tasks are ordered by dependency. The governing behavior and acceptance journeys
are in [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md). H-022 through H-025 were
implemented on 2026-09-23 and moved to [features.md](features.md). This backlog
now starts at the first unfinished slice.

## Slice 3 — context workbench

### H-026 Unify context, annotation editing, and proposal review

**Current status:** the unified workbench, named durable chips, add/remove
picker, packet manifest, stale generation rejection, and native-undo apply are
implemented. Shared `@`/context-menu entry, provisional adoption review, and a
review lifecycle for annotation mutations remain.

- **Scope:** Replace the read-only inspector with one contextual workbench.
  `@`, **Add context…**, slash actions, and node context menus use the H-025
  picker with a pinned consumer. Show named context chips and an exact packet
  preview. Put intent, contract, stub, lock, and context mutations through one
  host-owned proposal/review/apply lifecycle.
- **Acceptance:**
  - Annotation, chip, graph edge, persisted project, and packet manifest agree.
  - The UI explains that context does not imply an import or call dependency.
  - Provisional dependencies offer an explicit adoption diff.
  - Editing source while a proposal is open makes acceptance fail stale while
    preserving the draft.
  - Acceptance rechecks document versions/hashes and applies one native-undo
    `WorkspaceEdit`.
  - Unsafe cross-file `REASSIGN` is removed from the primary surface.
- **Depends:** H-024, H-025.
- **Blocks:** H-027, H-030.

**Milestone:** after H-026, dogfood Slate daily for search, exact navigation,
and context planning without model generation.

## Slice 4 — safe single-function loop

### H-027 Generate and review one function with a deterministic fake model

**Current status:** bounded packets, honest streaming activity, cancellation,
structural confinement, proposal review, freshness checks, accept, and undo are
implemented and fake-transport tested. Inline candidate editing, regenerate,
and Extension Host coverage of the complete fake-model accept journey remain.

- **Scope:** Define eligibility for supported typed functions/methods, build a
  bounded packet with output headroom, stream honest activity events from the
  fake server, confine candidate edits to the owned unit body, and expose diff,
  diagnostics, accept, edit, regenerate, and cancel in the workbench.
- **Acceptance:**
  - Extra declarations, module statements, signature/decorator changes, locked
    descendants, and edits outside the owned region are rejected.
  - Required context is never silently truncated; omissions and budget use are
    visible before send.
  - Target or dependency changes invalidate acceptance and preserve the draft.
  - Accept and undo pass through the real Extension Host fixture.
  - Cancellation and malformed streams never mutate source.
- **Depends:** H-022, H-023, H-026.
- **Blocks:** H-028, H-030.

## Slice 5 — llama.cpp and validation

### H-028 Connect the proven loop to llama.cpp

**Current status:** endpoint/model/budget/timeout settings, streaming,
cancellation, transport failure coverage, and a real 0.5B server smoke test are
implemented. Health UI, bounded revision feedback, trusted-workspace Ruff,
Basedpyright, and targeted pytest validation remain.

- **Scope:** Add extension-host transport for a workspace-configured llama.cpp
  server: endpoint, model, context window, output budget, timeout, health,
  streaming, and cancellation. Add staged candidate validation and bounded
  revision feedback.
- **Acceptance:**
  - Fake transport tests cover chunking, malformed payloads, disconnects,
    timeout, cancellation, unavailable server, and context overflow.
  - A tagged real-server smoke test generates one fixture leaf function.
  - No model picker or silent cloud fallback appears.
  - Syntax and structural checks always run; configured Ruff, Basedpyright, and
    targeted pytest commands run only in trusted workspaces against candidate
    snapshots.
  - Activity says what the harness included and checked, never what the model
    allegedly browsed or thought.
- **Depends:** H-027.
- **Blocks:** H-029, H-030.

### H-029 Pilot the harness on one human Python project

- **Scope:** Select one non-sensitive, maintained 10–30-module Python project.
  Run staged read-only, planning, deterministic-proposal, and real llama.cpp
  trials on a branch. Capture failures as fixtures before fixing them.
- **Acceptance:**
  - At least one week of read-only search/navigation usage is recorded.
  - Three real upcoming functions have human-reviewed context packets.
  - Five low-risk leaf functions are attempted with llama.cpp and independent
    tests.
  - Report first-proposal acceptance, repair rounds, packet sizes, omitted
    required context, validation failures, navigation/indexing errors, and
    human review time versus ordinary prompting.
  - Queue work continues only if single-unit review is trusted.
- **Depends:** H-026 for read-only/planning stages; H-028 for generation stage.

## Slice 6 — queue the proven loop

### H-030 Implement explicit scheduling and a resumable review queue

- **Scope:** Define scheduling prerequisites separately from context inclusion.
  Compute eligible units and deterministic ordering for project, selection, or
  selected dependency subgraph. Pause for every proposal and persist intent,
  not stale trusted ranges.
- **Acceptance:**
  - Tests cover disconnected graphs, diamonds, cycles, methods, blocked and
    oversized units, accepted versus locked state, and source-order tie breaks.
  - Skip, regenerate, cancel, failure, close/reopen, and resume preserve work.
  - Every resumed item rechecks source and dependency revisions.
  - Upstream edits stale downstream proposals without erasing drafts.
  - Calculator and tic-tac-toe pass end to end through the fake model.
- **Depends:** H-024, H-026, H-027; begin only after H-029's decision gate.

## Slice 7 — retirement and release

### H-031 Retire the legacy runtime and harden packaging

**Current status:** the production extension and VSIX are harness-only; legacy
commands/editor/assets, browser model transport, state bridge, and Python
worker are absent. The static-site replacement and clean installed-VSIX
restart/update journey remain gated by the pilot and queue decision.

- **Scope:** Remove the old D3/card/chat authoring UI after replacement
  invariants are covered. Package one XYFlow harness, replace GitHub Pages with
  a static product page, and test clean install/update/restart.
- **Acceptance:**
  - Production extension contains no legacy runtime, browser model transport,
    Python worker bootstrap, or old provider/model UI.
  - Clean-profile VSIX completes search → context → generate → review → accept
    → undo after restart.
  - Static site contains current inspected screenshots and installation/local
    llama.cpp instructions, but no authoring or API-key surface.
  - All unit, browser, Extension Host, Electron, fake-model, migration, and
    fixture suites pass in CI.
- **Depends:** H-029, H-030.

## Deferred

- Autonomous model tools or shell execution.
- Complete static call graphs and arbitrary cross-file moves.
- Additional languages and generic adapter plugins.
- Markdown transformation graphs.
- Browser folder editing or browser llama.cpp access.
- Automatic stale-proposal rebasing.
