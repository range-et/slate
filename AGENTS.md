# Slate Agent Instructions

This document provides instructions and architectural context for autonomous AI agents (Antigravity, Claude Code, Cursor, Copilot, Gemini CLI, etc.) working in this repository.

## Scope

The active product is the React/XYFlow canvas in `src/harness/` and the VS Code extension in `vscode-extension/src/`. Read `BUILD_PLAN.md`, `SLATE_HARNESS_PLAN.md`, and the relevant source before changing behavior. Preserve unrelated user changes.

## Project Overview

Slate is a visual node canvas for composing software (Python first, then Prose / Grant & Research mode) — **"Grasshopper where you forge the atomic components as you build the software."** The active product is the **XYFlow harness**: a React/TypeScript webview in `src/harness/` (entry `src/harness.html`) hosted by the VS Code extension in `vscode-extension/src/` (TypeScript Python adapter on Lezer, `slate/` folder loader, port/compile/describe, search, `llama.cpp` transport, proposals, and the planned Frontier Architect MCP server).

- **Atomic Library Units (`slate/nodes/**/*.json`):** The per-project component library and the *only* place where raw code (or atomic text-transform operators in Prose mode) lives. Bounded by **JPL-60** (`≤60` lines per function node, explicit parameter/return type annotations, bounded control flow, `Pydantic` contract validation, `pytest` checks, and `mutmut` mutation testing).
- **Compositions / Flows (`slate/flows/**/*.json`):** Everything above the 60-line atomic level is a Flow — a wired graph of atomic library instances compiled deterministically (`flowToNode`) without any LLM writing glue code.
- **Two-Tier AI Division of Labor:**
  - **Tier 1 — Frontier Architect (Slate MCP Server, zero function bodies):** Connects frontier models to the live workspace to search/place spatial notes (`slate_find`, `slate_place_notes`), pan/zoom the live canvas camera (`slate_focus`), define typed atomic stubs + contracts + cases (`slate_define_stub`, refusing arbitrary body code), wire flows (`slate_wire_flow`), and split oversized (`>60`-line) nodes (`S-510`).
  - **Tier 2 — Local LLM Component Forge (`llama.cpp`):** Takes a single forge input micro-packet (`≤600` tokens total across the target atomic stub's signature/intent/contract, selected cases, any bounded retry feedback, and bounded neighbor signatures + intents; trimming neighbor context first and refusing oversized targets whose stub + cases + retry feedback alone exceed `600` tokens) and forges the `≤60`-line function body + its unit check (`S-512`), verified by `Pydantic` + `pytest` + `mutmut` (`S-511`, `S-513`).

### Workspace Structure

Projects are a `slate/` folder of JSON:
- `slate.json`: Project manifest (name, default language, compile target, library list).
- `layout.json`: Visual canvas positions, notes, and placeholders.
- `nodes/**/*.json`: One JSON file per atomic definition (lines of code, intent, contract, context, examples, uses).
- `flows/**/*.json`: Wires and instances (`flows/main.json` holds the root canvas wires and root call instances).

Core extension implementation files:
- Flow format and edits: `vscode-extension/src/flow.ts`.
- Format and loader: `vscode-extension/src/slate_folder.ts`.
- Host IO & dirty-buffer index: `vscode-extension/src/slate_folder_host.ts`.
- Port Python project to nodes: `port/python_importer.ts`.
- Describe nodes with llama.cpp: `port/describe.ts`.
- Compile project to Python modules: `compile/python.ts`.

Documentation map:
- Direction and architecture: [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)
- Product feature inventory: [features.md](features.md)
- Backlog and triage: [GitHub Issues](https://github.com/range-et/slate/issues)
- Standing workflow: [AGENTS.md](AGENTS.md) — finish and verify GitHub issues, then record the shipped result in `features.md`; no local issue backlog.
- Build plan and phase learnings: [BUILD_PLAN.md](BUILD_PLAN.md)
- Development loop: [DEV.md](DEV.md); local llama.cpp demo: [DEMO.md](DEMO.md)

## Common Commands

```bash
npm run dev               # Vite dev server, opens /harness.html?demo
npm run build             # Build landing page and harness webview -> dist/
npm test                  # Vitest unit tests (test/)
npm run test:webview      # Playwright against harness.html with a fake host
npm run test:harness      # All suites incl. Extension Host + workbench
npm run verify:baseline   # CI gate: port → compile → pytest of examples
npm run verify:launch     # Full launch gate (verify:baseline + test:qa)
npm run package-extension # Build a VSIX
npm run demo:llama        # Start the local llama.cpp demo server
```

## Standing Issue Workflow

[GitHub Issues](https://github.com/range-et/slate/issues) is the only source of truth for bugs, feature requests, priorities, dependencies and unfinished work. Do not create or maintain `issues.md` or a second local backlog.

When choosing work, triage the open GitHub issues and their comments/linked PRs: reproduce reported bugs, check for duplicates, establish acceptance criteria and prerequisites, and prioritize owner requests and blockers before the next planned slice. Record scope and unresolved dependencies on the GitHub issue. Read the relevant design documents and source, then carry the selected issue through implementation, regression tests and the required launch gate.

When the work is complete and verified, update `features.md` in the same change with the shipped behavior, completion date, GitHub issue/PR link, verification and any material limitations. `features.md` is the factual product inventory, not the task queue. Do not list unfinished targets as completed features. Reference the issue in the PR (`Closes #N` only when it is fully addressed), and close it once acceptance criteria are met and the work is merged. Keep partial work and follow-ups open on GitHub.

## Required Regression Coverage for Every Code Change

Every added or changed function/behavior must have meaningful automated tests. Add or update tests in the same change, covering successful behavior, invalid inputs, boundary cases, and failure/cancellation paths that apply. A bug fix must include a regression that fails without the fix. Pure helpers belong in Vitest; do not expose private implementation details merely to test them.

Also test how the change interacts with existing behavior. For user-facing code, cover affected controls and action chains: entry, selection/state changes, keyboard and pointer actions where supported, disabled/empty/error states, cancel/retry, and the resulting state after the action. Test persistence, dirty buffers, undo, and host commands in the real VS Code Extension Host when relevant. A mocked browser action message proves dispatch, not persistence or host behavior.

Maintain `test/UNIT_TEST_MATRIX.md` and `test/UX_QA_MATRIX.md` with the functions, controls, chains, test locations, and remaining coverage gaps. Add new matrix rows when adding functionality and update existing rows when behavior changes. Exercise meaningful interacting paths; do not claim all possible action permutations are covered. Never weaken assertions, silently skip suites, or mark manual coverage as automated just to pass a gate.

## Launch Gate

Before handing off a code change as launch-ready, run from the repository root:

```bash
npm run verify:launch
```

This is fail-fast and requires all of:

1. `verify:baseline`: all unit/matrix tests, active webview/landing page build, extension TypeScript compile, Python example round trips, port/compile round trips, and flow/library execution tests.
2. `test:qa`: Playwright browser interactions, real VS Code Extension Host tests, and real workbench/webview generation, undo/save, and native creation-dialog QA.

Use focused tests while developing, then run the full gate on the final changes. If any required suite fails or cannot run, fix the issue or report the exact blocker; the change is not launch-ready. Report the command and outcome at handoff.

Install root and extension dependencies (`npm ci`, `npm ci --prefix vscode-extension`), Python/pytest, and Chromium (`npx playwright install chromium`) first. Linux CI needs browser system dependencies and a virtual display; use `npx playwright install --with-deps chromium` and `xvfb-run -a npm run verify:launch`. The VS Code tests download the pinned test editor when absent; no live model is needed because tests use deterministic fake servers.

`scripts/package-extension.js` runs the gate before creating or installing a VSIX. GitHub Actions runs baseline and QA as separate jobs and combines them in the `Launch gate` check. Pages deployment depends on that reusable workflow passing. Repository administrators should require `Launch gate` in branch protection; workflow files alone do not enable GitHub branch protection.

## License

Dual-licensed: [PolyForm Noncommercial License 1.0.0](LICENSE.md#1-software-code--polyform-noncommercial-license-100) for source code and [CC BY-NC 4.0](LICENSE.md#2-graphics-branding--documentation--cc-by-nc-40) for graphics, media, and documentation (Indrajeet Haldar). See [LICENSE.md](LICENSE.md).
