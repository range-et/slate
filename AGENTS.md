# Slate repository instructions

## Scope

The active product is the React/XYFlow canvas in `src/harness/` and the VS Code
extension in `vscode-extension/src/`. Read `CLAUDE.md`, `BUILD_PLAN.md`, and the
relevant source before changing behavior. `legacy/` is frozen but still deployed;
keep its existing tests and builds passing. Preserve unrelated user changes.

## Required regression coverage for every code change

Every added or changed function/behavior must have meaningful automated tests.
Add or update tests in the same change, covering successful behavior, invalid
inputs, boundary cases, and failure/cancellation paths that apply. A bug fix must
include a regression that fails without the fix. Pure helpers belong in Vitest;
do not expose private implementation details merely to test them.

Also test how the change interacts with existing behavior. For user-facing code,
cover affected controls and action chains: entry, selection/state changes,
keyboard and pointer actions where supported, disabled/empty/error states,
cancel/retry, and the resulting state after the action. Test persistence, dirty
buffers, undo, and host commands in the real VS Code Extension Host when relevant.
A mocked browser action message proves dispatch, not persistence or host behavior.

Maintain `test/UNIT_TEST_MATRIX.md` and `test/UX_QA_MATRIX.md` with the functions,
controls, chains, test locations, and remaining coverage gaps. Add new matrix rows
when adding functionality and update existing rows when behavior changes. Exercise
meaningful interacting paths; do not claim all possible action permutations are
covered. Never weaken assertions, silently skip suites, or mark manual coverage as
automated just to pass a gate.

## Launch gate

Before handing off a code change as launch-ready, run from the repository root:

```bash
npm run verify:launch
```

This is fail-fast and requires all of:

1. `verify:baseline`: all unit/matrix tests, active webview build, extension
   TypeScript compile, frozen legacy tests/build, Python example round trips,
   port/compile round trips, and flow/library execution tests.
2. `test:qa`: Playwright browser interactions, real VS Code Extension Host tests,
   and real workbench/webview generation, undo/save, and native creation-dialog QA.

Use focused tests while developing, then run the full gate on the final changes.
If any required suite fails or cannot run, fix the issue or report the exact
blocker; the change is not launch-ready. Report the command and outcome at handoff.

Install root and extension dependencies (`npm ci`, `npm ci --prefix
vscode-extension`), Python/pytest, and Chromium (`npx playwright install chromium`)
first. Linux CI needs browser system dependencies and a virtual display; use
`npx playwright install --with-deps chromium` and `xvfb-run -a npm run verify:launch`.
The VS Code tests download the pinned test editor when absent; no live model is
needed because tests use deterministic fake servers.

`scripts/package-extension.js` runs the gate before creating or installing a VSIX.
GitHub Actions runs baseline and QA as separate jobs and combines them in the
`Launch gate` check. Pages deployment depends on that reusable workflow passing.
Repository administrators should require `Launch gate` in branch protection;
workflow files alone do not enable GitHub branch protection.
