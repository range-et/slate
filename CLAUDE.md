# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Slate is a node canvas for composing Python with a local LLM. The active
product is the **XYFlow harness**: a React/TypeScript webview in `src/harness/`
(entry `src/harness.html`) hosted by the VS Code extension in
`vscode-extension/src/` (TypeScript Python adapter on Lezer, `slate/` folder
loader, port/compile/describe, search, llama.cpp transport, proposals).

- Direction: [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)
- Inventory: [features.md](features.md)
- Backlog: [issues.md](issues.md)
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

CC BY-NC-ND 4.0 (Indrajeet Haldar)
