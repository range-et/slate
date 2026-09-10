# Slate Python Harness Port

Status: proposed — implementation waits for explicit approval.

## Product contract

Slate is a Python-first, local-LLM development harness presented as one XYFlow
graph. A project JSON binds Slate to a folder and stores project identity,
tracked files, stable node identities, explicit context edges, locks, queue
state, and graph layout. Python files and dirty VS Code buffers remain the
authority for executable source.

The primary loop is:

1. Open a folder-associated `.slate.json` project or create one from a Python
   folder.
2. Browse files, classes, functions, methods, and planning notes in XYFlow.
3. Create a typed stub by defining its signature, intent, expected inputs and
   outputs, dependencies, and optional tests.
4. Slate inserts valid annotated Python containing `raise NotImplementedError`.
5. Generate one stub or queue all eligible stubs, leaves first.
6. For every stub, a local model returns a bounded proposal. Slate formats,
   parses, type-checks, and runs targeted tests before showing the diff.
7. Accept, regenerate, edit, skip, or lock the proposal. Acceptance is a VS
   Code source edit with native undo.
8. Any source edit is reparsed into the graph. Graph and code navigation work
   in both directions.

There is no model picker in this loop. Provider, endpoint, model, context limit,
and validation commands are workspace settings.

## Runtime boundaries

```text
React + TypeScript webview
  XYFlow canvas | node inspector | proposal diff | command bar | queue
                         |
                  typed messages
                         |
VS Code TypeScript extension
  project binding | document versions | watchers | navigation | WorkspaceEdit
              |                              |
           stdio                           HTTP
              |                              |
Python worker (LibCST)                    Ollama
  parse | annotate | stub | patch          proposals only
              |
   ruff + basedpyright + pytest
```

The extension is the only component allowed to read current dirty buffers or
write workspace files. The Python worker receives snapshots and returns parsed
units or proposed edits; it never watches or writes files. Ollama never chooses
a path, source range, node ID, or tool invocation.

## Data ownership

| Data | Authority |
|---|---|
| Python text, signatures, decorators, ordering | Dirty editor buffer, then `.py` |
| Unit ID, intent, contract, dependencies, lock | Versioned `## @slate` comment block |
| Project/folder identity, tracked paths, layout, queue | `.slate.json` |
| Names, kinds, parent relationships, ranges, diagnostics | Derived from source |
| Generated code | Proposal until explicitly accepted |

`Project → Documents → Cards` remains the serialized logical shape. A Document
maps to an exact relative Python path. A Card maps to a function, method, class
container, or explicit note. Persisted source/ranges are caches only and must
never authorize an overwrite.

Graph containment, explicit generation context, and inferred code references
are separate edge types. A context edge does not create an import.

## Typed stub and annotation contract

```python
## @slate v=2 id=90ab6379-0438-4d6d-bc83-bd355513f28f
## intent: Normalize incoming records.
## contract: Preserve ordering and reject missing identifiers.
## depends-on: f071f017-fc8a-47c9-8bd2-aa5146dfbd55
## example: [{"id": "a"}] => [{"id": "a", "valid": true}]
## locked: false
## @slate-end
def normalize(records: list[dict[str, str]]) -> list[dict[str, object]]:
    raise NotImplementedError("Slate stub: normalize")
```

Python has no multiline-comment syntax. Delimited comments avoid changing
runtime behavior or `__doc__`. LibCST associates the comment block with the
following declaration, before decorators, and preserves unknown fields.

A stub is eligible for generation when it is unlocked, has a complete typed
signature and intent, still has a recognized stub body, and all required
upstream nodes are accepted or locked. Classes are containers; methods are
generation units. Nested functions are navigable but not independently
generated in the first release.

## Generate queue

The existing Generate All behavior remains, with explicit state and safer
semantics:

- Scope is all eligible cards in the active project, selected nodes, or the
  selected dependency subgraph.
- Ordering is leaves first, with deterministic file/source order as a tie-break.
- The queue pauses on each proposal for `accept`, `edit`, `regenerate`, `skip`,
  `lock`, or `cancel queue`.
- Accepted and locked cards are never regenerated implicitly.
- Queue state persists in project JSON so a session can resume.
- A stale source or dependency revision invalidates the proposal and preserves
  its draft for regeneration.
- One failure does not discard the queue; the card is marked blocked and the
  user decides whether to continue.

Each generation packet contains only the unit annotation/signature, enclosing
class and necessary module context, direct explicit dependencies, relevant test
contracts, and a bounded recent revision prompt. Enforce both token and source
line limits; 100–200 lines is a ceiling signal, not a function-size target.

## Validation policy

Validation is staged so cheap failures arrive first:

1. Parse the candidate module with LibCST/Python.
2. Verify the edit stayed inside approved ranges and preserved identity,
   signature, decorators, and locked descendants unless explicitly permitted.
3. Run Ruff formatting/checks on the candidate snapshot.
4. Run Basedpyright in strict mode for affected files.
5. Run targeted pytest tests, followed by the project test command at user
   checkpoints.

Diagnostics are attached to graph nodes. Failed validation blocks one-click
acceptance by default but leaves the proposal editable. Project-specific
commands may be configured; Slate does not rewrite the repository's own Ruff,
Pyright, or pytest configuration.

## Test architecture

- **Python unit tests:** annotation ownership, extraction, ranges, stub creation,
  minimal patching, decorators, classes/methods, async functions, Unicode, CRLF,
  malformed files, duplicate IDs, and no-op byte preservation.
- **Python property/golden tests:** parse → project → no-op render changes zero
  bytes; a unit replacement changes only its permitted region.
- **TypeScript unit tests:** project migration, queue ordering/resume, context
  budgets, stale proposal rejection, typed host messages, and graph adapters.
- **React component tests:** selection, queue controls, inspector drafts,
  parse-error/stale states, and diff acceptance intent.
- **VS Code integration tests:** dirty-buffer authority, external file changes,
  graph↔editor navigation, WorkspaceEdit/undo, and stale version conflicts.
- **End-to-end fixtures:** calculator and tic-tac-toe must scan, stub, generate
  with a deterministic fake model, validate, accept, reopen, and pass their
  Python tests. Existing Vitest and round-trip tests remain required until an
  equivalent source-first test replaces each invariant.

## Delivery breakpoints and manual gates

### Breakpoint 0 — frozen baseline

Automated gate: current `npm test`, web build, extension TypeScript build, and
calculator Python tests pass.

Manual gate:
- Open both calculator project variants.
- Run current Generate All and Compile All once.
- Confirm existing annotated Python rehydrates.

This is a regression reference only; no new architecture ships here.

### Breakpoint 1 — Python engine, read-only

Automated gate: lossless LibCST fixtures and worker protocol tests pass.

Manual gate:
- Scan a small typed repository containing files, classes, methods, decorators,
  async functions, empty files, and a temporarily invalid file.
- Compare every displayed node and source range with VS Code.
- Confirm scanning changes no workspace byte.

### Breakpoint 2 — XYFlow source browser

Automated gate: React, graph adapter, host protocol, and navigation integration
tests pass.

Manual gate:
- Open a `.slate.json`; confirm there is one graph view rather than card/doc/
  graph panels.
- Pan, zoom, fit, collapse classes, select multiple nodes, and restart VS Code;
  layout and selection scope should behave predictably.
- Jump graph→code and code→graph repeatedly without focus loops.
- Edit an open dirty Python buffer and externally edit an unopened file; both
  update the graph. Invalid syntax visibly retains the last-good graph.

### Breakpoint 3 — typed stub round trip

Automated gate: stub/annotation/patch tests, strict type checks, WorkspaceEdit,
undo, conflict, and migration tests pass.

Manual gate:
- Create top-level, async, decorated, and method stubs from the graph.
- Enter concrete input/output examples and confirm generated Python imports and
  executes while raising `NotImplementedError` only when called.
- Edit signature/intent in source and see the graph update.
- Edit the same fields in the graph and inspect the exact source diff.
- Undo in VS Code and verify the graph returns to the prior state.
- Create a stale edit and duplicate ID; confirm Slate refuses to write and loses
  no draft.

### Breakpoint 4 — one-card local generation

Automated gate: deterministic fake-model tests cover context construction,
limits, validation failures, cancellation, and stale dependency rejection.

Manual gate:
- Generate leaf functions using an actual configured Ollama model.
- Inspect the full context manifest and diff.
- Exercise malformed output, unavailable Ollama, timeout, cancellation, type
  failure, style failure, and test failure.
- Accept a valid proposal, undo it, edit manually, and regenerate.
- Confirm no model picker and no silent cloud fallback exist.

### Breakpoint 5 — Generate All / subgraph queue

Automated gate: leaves-first ordering, cycles, locks, skip/resume/cancel, blocked
cards, persistence, and per-card revision tests pass. Calculator and tic-tac-toe
pass end to end through the deterministic fake model.

Manual gate:
- Queue a mixed project containing accepted, locked, stubbed, failing, cyclic,
  and oversized units.
- Confirm only eligible units enter the queue and proposals stop for review.
- Close/reopen midway and resume.
- Modify an upstream function midway; dependent proposals must become stale.
- Complete calculator using Ollama and run its full pytest/typecheck commands.

This is the first release candidate for daily use.

### Breakpoint 6 — legacy retirement and static site

Automated gate: production extension package, clean-install worker bootstrap,
migration suite, all unit/integration/E2E tests, and static-site build pass.

Manual gate:
- Install the VSIX into a clean VS Code profile and open both a legacy Slate
  project and an ordinary Python folder.
- Complete one stub→queue→accept→test workflow after restart.
- Verify the GitHub Pages site is only a fast static feature page with current
  screenshots and extension installation instructions.
- Confirm no old D3/card/chat UI route remains in the extension bundle.

After this gate, delete legacy code that no longer supports migration or a
still-running invariant. Do not delete it earlier merely to make the tree look
new.

## Deferred until after the Python release

- Markdown split/merge/summarize transformation graph.
- Autonomous model tool loops or shell execution.
- Additional programming languages.
- Automatic stale-proposal rebasing.
- Cross-file symbol moves and complete static call-graph inference.
- Browser-based folder authoring or browser-to-Ollama access.
