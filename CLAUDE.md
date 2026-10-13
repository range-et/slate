# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Slate is a node canvas for composing Python with a local LLM. The active
product is the **XYFlow harness**: a React/TypeScript webview in `src/harness/`
(entry `src/harness.html`) hosted by the VS Code extension in
`vscode-extension/src/` (TypeScript Python adapter on Lezer, project-v2
loader, search, llama.cpp transport, proposals).

- Direction: [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)
- Inventory: [features.md](features.md)
- Backlog: [issues.md](issues.md)
- How to build the next phase (code map, conventions, verification, learnings): [BUILD_PLAN.md](BUILD_PLAN.md)
- Dev loop: [DEV.md](DEV.md); llama.cpp demo: [DEMO.md](DEMO.md)

Projects are a `slate/` folder of JSON: `slate.json`, `layout.json`, and one
`nodes/**/*.json` per node (code as a list of lines plus intent, contract,
context, examples). Format and loader: `vscode-extension/src/slate_folder.ts`;
host IO: `slate_folder_host.ts`. The older project-v2 source-map mode
(`*.slate.json`, `## @slate` annotations in Python) remains until S-203.

`legacy/` holds the frozen original browser notebook, which GitHub Pages still
deploys. Do not build on it; see [legacy/CLAUDE.md](legacy/CLAUDE.md).

## Commands

```bash
npm run dev               # Vite dev server, opens /harness.html?demo=folder
npm run build             # Harness webview -> dist/ (served by the extension)
npm test                  # Vitest unit tests (test/)
npm run test:webview      # Playwright against harness.html with a fake host
npm run test:harness      # All suites incl. Extension Host + workbench
npm run verify:baseline   # CI gate (also keeps legacy/ green)
npm run package-extension # Build a VSIX
npm run demo:llama        # Start the local llama.cpp demo server
```

## License

CC BY-NC-ND 4.0 (Indrajeet Haldar)
