# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Slate is a visual node canvas for composing software (Python first, then Prose /
Grant & Research mode) — **"Grasshopper where you forge the atomic components as
you build the software."** The active product is the **XYFlow harness**: a
React/TypeScript webview in `src/harness/` (entry `src/harness.html`) hosted by
the VS Code extension in `vscode-extension/src/` (TypeScript Python adapter on
Lezer, `slate/` folder loader, port/compile/describe, search, `llama.cpp`
transport, proposals, and the planned Frontier Architect MCP server).

- **Atomic Library Units (`slate/nodes/**/*.json`):** The per-project component
  library and the *only* place where raw code (or atomic text-transform
  operators in Prose mode) lives. Bounded by **JPL-60** (`≤60` lines per
  function node, explicit parameter/return type annotations, bounded control
  flow, `Pydantic` contract validation, `pytest` checks, and `mutmut` mutation
  testing).
- **Compositions / Flows (`slate/flows/**/*.json`):** Everything above the
  60-line atomic level is a Flow — a wired graph of atomic library instances
  compiled deterministically (`flowToNode`) without any LLM writing glue code.
- **Two-Tier AI Division of Labor:**
  - **Tier 1 — Frontier Architect (Slate MCP Server, zero function bodies):**
    Connects frontier models (Claude, Gemini, Antigravity) to the live workspace
    to search/place spatial notes (`slate_find`, `slate_place_notes`), pan/zoom
    the live canvas camera (`slate_focus`), define typed atomic stubs +
    contracts + cases (`slate_define_stub`, refusing arbitrary body code), wire
    flows (`slate_wire_flow`), and split oversized (`>60`-line) nodes (`S-510`).
  - **Tier 2 — Local LLM Component Forge (`llama.cpp`):** Takes a single forge
    input micro-packet (`≤600` tokens total across the target atomic stub's
    signature/intent/contract, selected cases, any bounded retry feedback, and
    bounded neighbor signatures + intents; trimming neighbor context first and
    refusing oversized targets whose stub + cases + retry feedback alone exceed
    `600` tokens) and forges the `≤60`-line function body + its unit check
    (`S-512`), verified by `Pydantic` + `pytest` + `mutmut` (`S-511`, `S-513`).

- Direction: [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)
- Inventory: [features.md](features.md)
- Backlog and triage: [GitHub Issues](https://github.com/range-et/slate/issues)
- Standing workflow: [AGENTS.md](AGENTS.md) — finish and verify GitHub issues,
  then record the shipped result in `features.md`; no local issue backlog.
- How to build the next phase (code map, conventions, verification, learnings): [BUILD_PLAN.md](BUILD_PLAN.md)
- Dev loop: [DEV.md](DEV.md); llama.cpp demo: [DEMO.md](DEMO.md)

Projects are a `slate/` folder of JSON: `slate.json`, `layout.json` (canvas
positions, notes, refs, placeholders), one `nodes/**/*.json` per node (code as
a list of lines plus intent, contract, context, examples, uses), and
`flows/**/*.json` (instances and data wires; `flows/main.json` holds the root
canvas wires). Flow format and edits: `vscode-extension/src/flow.ts`. Format and loader: `vscode-extension/src/slate_folder.ts`;
host IO: `slate_folder_host.ts`. **Slate: Port Python Project…** splits an
existing project into nodes (`port/python_importer.ts`), **Describe nodes**
fills intents with llama.cpp (`port/describe.ts`), and **Slate: Compile
Project** writes Python modules back out (`compile/python.ts`).

`legacy/` holds the frozen original browser notebook, which GitHub Pages still
deploys. Do not build on it; see [legacy/CLAUDE.md](legacy/CLAUDE.md).

## Commands

```bash
npm run dev               # Vite dev server, opens /harness.html?demo
npm run build             # Harness webview -> dist/ (served by the extension)
npm test                  # Vitest unit tests (test/)
npm run test:webview      # Playwright against harness.html with a fake host
npm run test:harness      # All suites incl. Extension Host + workbench
npm run verify:baseline   # CI gate: port → compile → pytest, and keeps legacy/ green
npm run package-extension # Build a VSIX
npm run demo:llama        # Start the local llama.cpp demo server
```

## License

Dual-licensed: [PolyForm Noncommercial License 1.0.0](LICENSE.md#1-software-code--polyform-noncommercial-license-100) for source code and [CC BY-NC 4.0](LICENSE.md#2-graphics-branding--documentation--cc-by-nc-40) for graphics, media, and documentation (Indrajeet Haldar). See [LICENSE.md](LICENSE.md).
