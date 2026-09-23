# Slate Harness Plan

Status: active — revised 2026-09-23.

This is the only active product and architecture specification. The earlier
drafts were synthesized here and removed. Completed work is summarized in
[features.md](features.md); executable work is tracked in [issues.md](issues.md).

## Product thesis

Slate maintains an annotation-derived map of code so a developer—or a small
local model—can work on one precisely scoped function without rediscovering
its path, context, or safe edit boundaries.

The graph is not the product by itself. The product is deterministic search,
navigation, context assembly, proposal confinement, validation, and review.
The model only proposes code for a unit the harness has already selected.

## Product contract

1. Python files and dirty VS Code buffers are authoritative executable source.
2. `## @slate` annotations own durable unit IDs, intent, contract, explicit
   generation context, examples, and locks.
3. A validated `.slate.json` owns project binding, tracked paths, layout, and
   resumable work state. It never owns executable source or trusted ranges.
4. The extension host owns filesystem access, current document revisions,
   search, llama.cpp transport, validation orchestration, proposals, and final
   `WorkspaceEdit` application.
5. The webview displays the graph and workbench and sends typed user intent. It
   never authorizes a source edit with a path or range of its own.
6. The local model receives one bounded packet and returns one candidate unit.
   It cannot search, choose files, select ranges, invoke tools, or write source.
7. Every mutation is previewable, revision-bound, and undoable in VS Code.

## Primary workflow

```diagram
┌──────────────┐   ┌────────────────┐   ┌──────────────────┐
│ Find/select  │──▶│ Add context    │──▶│ Inspect packet   │
│ one unit     │   │ deliberately   │   │ and budget       │
└──────────────┘   └────────────────┘   └────────┬─────────┘
                                                ▼
┌──────────────┐   ┌────────────────┐   ┌──────────────────┐
│ Apply with   │◀──│ Review diff +  │◀──│ llama.cpp returns│
│ native undo  │   │ diagnostics    │   │ one candidate    │
└──────────────┘   └────────────────┘   └──────────────────┘
```

The central command bar is a guided action surface, not an LLM chat prompt.
For example:

```text
/search
  → What do you want to find?
  → normalize record
  → deterministic results with file, symbol, snippet, and match reason
  → Reveal | Select | Add as context
```

Buttons, context menus, shortcuts, slash commands, and graph gestures dispatch
the same typed actions. There must not be separate implementations for `@`,
context menus, and command-line context creation.

## Interaction model

### Graph and editor

- Single-click selects a node and reveals its current definition in the native
  editor without stealing keyboard focus.
- Enter or **Edit in code** focuses the editor.
- Editor movement highlights the deepest containing graph node without causing
  a reciprocal navigation loop.
- Navigation crosses the webview boundary by durable unit ID. The host resolves
  the current path and range from its revisioned index.
- Multi-selection uses normal modified-click behavior and never opens a file
  per selected node.

### Search

The first search implementation covers names, qualified names, signatures,
annotations, and dirty-buffer source text. Results are stable, explain why they
matched, disambiguate repeated names, and remain bound to a source revision.
Static call-graph inference and embeddings are not prerequisites.

### Context

With consumer A selected, **Add context…**, `@`, and the node context menu open
the same search picker while keeping A visibly pinned. Selecting B writes B's
durable ID into A's annotation and displays a named `@B` chip.

The UI must explain: “Included when generating A. Does not create an import or
prove that A calls B.” Context inclusion and generation ordering are separate
concepts. A missing durable ID triggers an adoption proposal, never a hidden
title-based guess.

### Workbench

One contextual side panel replaces disconnected inspectors and modal flows:

- **Inspect:** signature, intent, context, source state, diagnostics.
- **Search:** query and actionable results.
- **Prepare:** annotation/stub edit and exact source preview.
- **Generate:** packet manifest, budget, cancellation, and activity.
- **Review:** candidate diff, checks, accept, edit, regenerate, or cancel.

### Honest agent-like activity

Visible traversal is useful as provenance, not simulated agency. The host emits
events only for work it actually performed:

```text
Resolved target
Included explicit context: normalize, Record
Built packet: 1,842 input tokens; omitted 0 required items
Requested llama.cpp
Received candidate
Checked structural confinement
Ran configured validation
Ready for review
```

Events may highlight included nodes and show their excerpts. They must not add
artificial delays, claim the model read unprovided files, or move the user's
editor repeatedly. “Follow activity” is optional.

## Runtime architecture

```diagram
┌────────────────────────────────────────────────────────────┐
│ React + TypeScript webview                                 │
│ graph │ command workflows │ workbench │ diff │ activity    │
└───────────────────────────┬────────────────────────────────┘
                            │ typed actions/events
┌───────────────────────────▼────────────────────────────────┐
│ VS Code TypeScript extension                              │
│ revisioned index │ search │ proposals │ validation │ queue │
└──────────────┬───────────────────────────────┬─────────────┘
               │ pure calls                    │ HTTP/SSE
┌──────────────▼────────────────┐  ┌───────────▼─────────────┐
│ TypeScript Python adapter     │  │ llama.cpp server        │
│ parse │ ranges │ annotations  │  │ bounded completion only │
│ constrained source patches   │  └─────────────────────────┘
└───────────────────────────────┘
```

The shipped extension must not bootstrap a Python environment or LibCST.
The TypeScript adapter may use Lezer for syntax structure, but must preserve
original text and create edits by slicing exact ranges rather than regenerating
modules. Lezer error recovery is not proof that a module is valid; parse errors
must be surfaced explicitly.

Project validation tools such as Ruff, Basedpyright, and pytest are optional,
workspace-trusted commands run against candidate snapshots. They are not part
of installing Slate and are not a security sandbox.

llama.cpp endpoint, model, context window, output budget, timeout, and validation
commands are workspace settings. There is no primary-flow model picker and no
silent cloud fallback.

## Proposal safety

Every source-changing action follows one proposal protocol:

1. Capture source text, document version/hash, unit identity, dependency
   revisions, and permitted edit regions.
2. Prepare an immutable host-owned proposal and show its exact diff.
3. Validate structural confinement and configured checks without replacing the
   user's source.
4. On acceptance, recheck every precondition.
5. Apply the reviewed edit set as one `WorkspaceEdit`; retain the proposal when
   stale or rejected.

The first generation implementation replaces only a supported function or
method body. It rejects extra declarations, module statements, signature or
decorator changes, and targets containing unsupported locked descendants.

Cross-file `REASSIGN` is not a primary action until imports and consumers can be
updated safely.

## Test platform

Slate must be testable by an agent without relying on manual computer use.
The test platform is a product requirement, not final release polish.

### Layers

1. **Pure adapter tests:** golden and property tests for UTF-16 positions,
   annotations, decorators, multiline signatures, nested units, CRLF, Unicode,
   invalid source, duplicate IDs, no-op byte preservation, and confined edits.
2. **Webview tests:** Vitest for reducers/actions plus Playwright against
   `harness.html` with a typed fake host. Cover keyboard workflows, menus,
   search results, context chips, packet manifests, progress, and diff review.
3. **Extension Host tests:** `@vscode/test-electron` launches a pinned local VS
   Code build with fixture workspaces. Tests exercise dirty-buffer authority,
   external edits, exact reveal, editor→graph selection, `WorkspaceEdit`, undo,
   trust checks, persistence, and restart recovery through VS Code APIs.
4. **Electron journey tests:** a small Playwright/CDP suite drives the actual VS
   Code workbench and webview for representative cross-boundary journeys. Keep
   selectors/test hooks explicit and the suite small because workbench DOM is
   more fragile than Extension Host APIs.
5. **Model transport tests:** a local fake llama.cpp-compatible HTTP server
   streams deterministic chunks and exercises cancellation, timeout, malformed
   output, context overflow, and server failure. A separately tagged smoke test
   targets a real configured llama.cpp server.
6. **Artifacts:** failing journeys retain screenshots, webview action traces,
   host event logs, proposal diffs, and the fixture workspace.

### Required acceptance journeys

- `/search` → disambiguated result → exact dirty-buffer source reveal.
- Select A → add `@B` → annotation, graph edge, chip, and packet agree → undo.
- Create typed stub → preview → apply → undo → restart and re-index.
- Generate with fake server → inspect real activity events → review diff →
  accept → undo.
- Edit target or dependency during generation → acceptance is rejected as
  stale and the draft survives.
- Cancel a stream; malformed or out-of-scope output never mutates source.
- Temporarily break Python syntax; last-good graph is visibly stale and recovers.
- Close and reopen during a queued run; resumed entries recheck all revisions.

## Delivery plan

### Slice 0 — executable test platform

Add the fake host, fixture workspaces, `@vscode/test-electron`, fake llama.cpp
server, artifact capture, and one browser plus one Extension Host smoke journey.
No feature is considered shipped without the appropriate layer here.

### Slice 1 — installable source map

Replace the Python worker with the pure TypeScript adapter. Wire a validated v2
project loader, tracked paths, project-wide identity checks, revisioned indexing,
and a clean-profile VSIX test. Remove Python bootstrap commands and packaging.

### Slice 2 — unified search and navigation

Introduce typed actions and guided `/search`; make click/keyboard navigation
exact in both directions. Results search dirty source and annotations and can be
reused by later workflows.

### Slice 3 — context workbench

Ship the shared context picker, named chips, annotation adoption, packet preview,
intent editing, and the common proposal/review/apply lifecycle.

**This is the first daily-usable milestone:** find code, navigate exactly,
declare context, and inspect what a model would receive without invoking one.

### Slice 4 — safe single-function loop

Using a deterministic fake model, create a typed stub, build a bounded packet,
stream real activity, review a confined proposal, accept it, and undo it. Close
freshness gaps before any real-model integration.

### Slice 5 — llama.cpp generation and validation

Connect the same loop to configured llama.cpp, enforce real input/output budgets,
support cancellation and retries, and stage syntax, structure, format/type, and
targeted-test diagnostics. No silent writes or fallback providers.

### Slice 6 — proven queue

Queue eligible selected units or a dependency subgraph, pause on each proposal,
persist/resume, preserve blocked work, and stale downstream proposals when an
upstream revision changes. Queueing reuses the single-function loop unchanged.

### Slice 7 — retirement and release

Remove the legacy notebook runtime after its remaining invariants have source-
first replacements. Package one extension UI and replace the web application
with a static product page and inspected screenshots.

## Human-project adoption

Do not wait for Generate All before using Slate on real work. Select one
non-sensitive, actively maintained Python project with roughly 10–30 modules,
tests, repeated names, classes, and at least one dirty/partially typed area.
The owner keeps Git as the rollback boundary.

1. **After Slice 2 — read-only pilot:** index the project for one week; use
   search and navigation during normal work. Record wrong/missing units,
   navigation failures, latency, and commands the user expected.
2. **After Slice 3 — planning pilot:** annotate three upcoming functions and
   declare context. Compare packet contents with what the human would have given
   an agent. No generated code is applied.
3. **After Slice 4 — deterministic rehearsal:** run fake proposals against a
   disposable branch to prove diff, staleness, undo, and artifact capture.
4. **After Slice 5 — real model pilot:** choose five low-risk leaf functions
   with independent tests. Measure first-proposal acceptance, repair rounds,
   packet size, omitted required context, validation failures, and human review
   time. Compare with the same llama.cpp model given an ordinary prompt.
5. **Before Slice 6 — decision gate:** queue work proceeds only if single-unit
   review is trusted and the measured failures are retrieval/context problems
   the harness can improve—not reasoning tasks beyond the selected model.

## Deferred

- Autonomous model search, shell, or tool loops.
- Complete static call-graph inference and arbitrary cross-file refactors.
- Additional programming languages or a generic adapter plugin framework.
- Markdown transformation graphs.
- Browser folder authoring or browser-to-llama.cpp access.
- Automatic stale-proposal rebasing.
