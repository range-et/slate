---
tags: [project, slate, features]
status: living
---

# Slate — implemented features

This is a concise factual inventory of shipped code. It is not a roadmap.
Active architecture lives in [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md) and
unfinished work lives in [issues.md](issues.md). Detailed implementation history
remains available in Git.

## Legacy notebook baseline

The legacy application under `src/` still provides:

- Project → Documents → Cards JSON import/export.
- Markdown, Python code, header, and class-card rendering.
- Explicit project-wide `@` references and bibliography construction.
- OpenAI, Gemini, and an OpenAI-compatible local agent originally configured
  for Ollama. This is legacy behavior; llama.cpp is the active future backend.
- Streaming/cancellation, project-wide Generate All, and Compile All.
- Python compile/download/workspace-write flows.
- `## @slate` compile → rehydrate → compile round-trip support.
- D3 graph navigation, workspace scanning, and VS Code webview hosting.
- Calculator and tic-tac-toe regression fixtures.

This baseline is retained only until equivalent source-first invariants are
covered. It is not the target interaction or ownership model.

## Source-first harness foundation

### Versioned contracts and reproducible baseline

- Project-v2 and worker protocol JSON schemas exist under `contracts/`.
- `npm run verify:baseline` gates Vitest, Vite build, extension compilation,
  parser/patcher tests, round-trip fixtures, and example Python tests.
- Calculator and tic-tac-toe compile in isolated temporary directories so tests
  do not accidentally consume checked-in output.
- Resolved 2026-09-10 in
  [`70fc4d1`](https://github.com/range-et/slate/commit/70fc4d1fe5f288a5a03e10c1bdc48987fce29238).

### LibCST parser/patcher prototype

- A supervised newline-delimited JSON worker parses Python snapshots without
  workspace access.
- It extracts classes, functions, methods, nested declarations, decorators,
  signatures, annotations, durable/provisional IDs, UTF-16 ranges, diagnostics,
  and source hashes.
- It prepares checked proposals for annotation adoption/update, typed stub
  insertion, unit replacement, and top-level moves.
- Tests cover async/decorated/nested declarations, Unicode, CRLF, malformed
  source, stale hashes, duplicate IDs, locks, typed signatures, and moves.
- Resolved as a prototype in
  [`70fc4d1`](https://github.com/range-et/slate/commit/70fc4d1fe5f288a5a03e10c1bdc48987fce29238)
  and
  [`b9e8f2f`](https://github.com/range-et/slate/commit/b9e8f2f1269c510f80669e15f9795c412cae06ef).

The prototype proves contracts and fixtures, but its Python/LibCST bootstrap
failed the desired clean packaged-extension experience. It is migration input
for the approved pure-TypeScript adapter, not the shipping runtime.

### XYFlow source browser

- The React/TypeScript harness is the default editor for `.slate.json` files;
  the legacy notebook remains available through **Open With**.
- Python files, classes, functions, methods, and nested declarations render as
  grouped XYFlow nodes.
- Dirty buffers outrank disk snapshots. Temporarily invalid source retains a
  visibly stale last-good graph.
- Graph double-click/inspector actions reveal source; editor selection highlights
  the deepest containing node.
- Layout persists in project JSON or workspace state.
- Context edges remain visually distinct from containment.
- Resolved in
  [`cd0b40b`](https://github.com/range-et/slate/commit/cd0b40bfa89cde20d2c37aaa887ccab5b22db53a)
  and
  [`d77c500`](https://github.com/range-et/slate/commit/d77c50024845c5af7e8964da7f8a7b43678f6480).

### CAD-style command prototype

- The webview parses deterministic commands with token completion and history.
- Selection, reveal/edit, fit, clear, typed stub creation, intent/contract
  updates, context add/remove, locks, compile/re-index, and save commands are
  wired. Unsafe cross-file move was removed from the primary surface.
- Source mutations use adapter proposals and VS Code `WorkspaceEdit`.
- Resolved in
  [`b9e8f2f`](https://github.com/range-et/slate/commit/b9e8f2f1269c510f80669e15f9795c412cae06ef).

### Agent-runnable test platform

- Playwright runs `harness.html` against an injected VS Code host and verifies
  the guided search and ID-based reveal journey.
- A pinned VS Code 1.139 Electron build runs an Extension Host fixture that
  proves dirty-buffer indexing, exact reveal, `WorkspaceEdit`, and native undo.
- A separate Playwright/Electron workbench smoke test renders the real Slate
  webview inside an Extension Development Host and captures an inspected image.
- A deterministic OpenAI-compatible fake llama.cpp server records requests and
  streams SSE chunks for later generation tests.
- `npm run test:harness` composes unit, browser, Extension Host, and workbench
  checks; CI installs the browser and retains Playwright failure artifacts.
- Implemented 2026-09-23 in the current worktree.

### Pure TypeScript Python runtime

- `@lezer/python` now indexes annotations, decorators, async/multiline
  signatures, classes, methods, nested declarations, Unicode/UTF-16 ranges,
  CRLF source, provisional IDs, duplicate IDs, and syntax diagnostics in-process.
- Annotation adoption/update, typed stub insertion, and confined same-signature
  function replacement produce hash-bound source proposals.
- The extension no longer starts, configures, packages, or bootstraps a Python
  worker. Its host entry is bundled with esbuild so Lezer ships in the VSIX.
- The LibCST engine remains only as a reference prototype until final retirement.
- Implemented 2026-09-23 in the current worktree.

### Project-v2 runtime authority

- New and scanned projects use the checked project-v2 contract.
- The loader validates roots, tracked Python paths, card kinds, finite layout,
  and queue records; tracked paths alone enter a bound project index.
- Legacy projects migrate in memory without making title links authoritative.
  Newer schemas expose safe tracked source read-only and block source/layout
  mutations.
- Layout persistence uses project v2, annotation dependencies own context, and
  project-wide durable-ID collisions become diagnostics.
- Legacy project/layout/context helpers and regex workspace scanning were
  removed from the extension runtime.
- Implemented 2026-09-23 in the current worktree.

### Guided search and exact navigation

- `/search` enters a guided query state. The extension host ranks names,
  qualified names, IDs, signatures, annotation intent/contracts, tracked paths,
  and dirty-buffer declaration text.
- Results show path, signature, snippet, and match reason, then select/reveal by
  unit ID. Search logic is deterministic and independently tested.
- Single click reveals without taking keyboard focus; double-click, **Edit in
  code**, or Enter focuses the editor. The host reparses the current buffer and
  resolves the current name/declaration range instead of trusting webview paths.
- Implemented 2026-09-23 in the current worktree.

### Persistent planning board

- Freeform board notes persist in project metadata without modifying source.
- Notes can optionally attach to durable function identities and render a
  distinct dotted relationship edge.
- Right-click menus expose relevant actions for empty canvas, functions, and
  notes; note creation and editing stay in the contextual workbench.
- Two-finger trackpad scrolling pans freely, pinch gestures zoom, and ordinary
  node dragging remains available.
- Implemented 2026-09-23 in the current worktree.

### Playable confined llama.cpp loop

- The contextual workbench edits intent/contract, shows named context chips,
  adds/removes durable context, and previews every exact packet item and budget.
- A host-owned OpenAI-compatible transport streams from a configured llama.cpp
  endpoint with timeout and cancellation. It has no cloud fallback or model
  picker.
- Required context is never silently truncated. Generation is limited to typed,
  unlocked durable functions and methods with an intent.
- Candidate validation rejects malformed Python, extra module statements,
  decorators, renamed or re-signed declarations, and edits outside the owned
  function. Acceptance rechecks target and context hashes, applies one
  `WorkspaceEdit`, and exposes native undo.
- Fake transport tests cover chunking, malformed SSE, disconnect, timeout,
  cancellation, an unavailable server, and context overflow. A real 0.5B
  llama.cpp model generated the included fixture function in a local smoke
  test.
- `examples/llama_demo` and `npm run demo:llama` provide a runnable demo. The
  harness-only VSIX was packaged, inspected, and installed locally.
- Implemented 2026-09-23 in the current worktree.

### Production extension retirement

- The packaged extension now registers only the source-first XYFlow editor.
  Legacy notebook commands, custom editor, state bridge, browser model UI, and
  Python worker bootstrap were removed from the extension entry and VSIX.
- The old browser application remains in the repository and static Vite build;
  it is no longer shipped in the VS Code extension.
- Implemented 2026-09-23 in the current worktree.

## Known limits of the implemented harness

The following are not shipped features:

- `@` insertion and function context menus do not yet open the shared source
  context picker; provisional context adoption still uses command actions.
- Annotation/context mutations apply directly instead of entering the same
  review lifecycle as generated proposals.
- Proposal editing, regenerate/revision feedback, Ruff, Basedpyright, and
  targeted pytest validation are not implemented.
- The required week-long human-project pilot has not occurred.
- Dependency scheduling, resumable queues, and proposal restart recovery remain
  gated on that pilot.
- The GitHub Pages authoring UI has not been replaced by a static product page,
  and clean-profile installed-VSIX update/restart has not been exercised.
