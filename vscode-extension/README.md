# Slate Code

Slate Code is a node canvas for composing Python with a local LLM. A project
is a `slate/` folder of JSON: one file per node (code + intent, contract,
context, examples), plus `layout.json` for the canvas. A local llama.cpp
server can implement one node at a time.

## Build and install

```bash
# repository root
npm install
npm --prefix vscode-extension install
npm run package-extension -- --install
```

Reload VS Code after installation. Run **Slate: New Project** in a folder (or
open an existing `slate/slate.json`). Right-click empty canvas for **New
node…** or a board note. Click selects; double-click opens the node JSON. The
workbench edits intent, contract, context, and code. Layout and notes live in
`slate/layout.json` and never touch node files.

The older source-map mode (**Slate: Scan Python Workspace**, `*.slate.json`
projects that index existing Python in place) still works until the Phase 2
importer replaces it.

## Local generation

```bash
# repository root; first run downloads the 491 MB default GGUF
npm run demo:llama
```

Select a typed node with an intent. The workbench shows its intent, contract,
named context, and exact packet budget. **Generate with llama.cpp** streams
through the extension host. Slate validates that the response is one Python
function with the same name and signature before offering to write it into the
node. Node or context changes make acceptance stale and preserve the draft.

Settings:

- `slate.llama.endpoint` (default `http://127.0.0.1:8080`)
- `slate.llama.model` (request label; no model picker or cloud fallback)
- `slate.llama.contextWindow`
- `slate.llama.outputTokens`
- `slate.llama.timeoutSeconds`

See `DEMO.md` at the repository root for the included playable project.
