# Slate Code

Slate Code is a source-linked Python harness for VS Code. It indexes typed
functions into a graph, navigates by durable identity, makes required context
explicit, and asks a local llama.cpp server to implement one confined function
at a time.

## Build and install

```bash
# repository root
npm install
npm --prefix vscode-extension install
npm run package-extension -- --install
```

Reload VS Code after installation. Open a Python workspace and run
**Slate: Scan Python Workspace**, or open an existing `*.slate.json` project.

## Local generation

```bash
# repository root; first run downloads the 491 MB default GGUF
npm run demo:llama
```

Select a typed, annotated function. The right workbench shows its intent,
contract, named context, and exact packet budget. **Generate with llama.cpp**
streams through the extension host. Slate validates that the response is one
Python function with the same name and signature before offering a
WorkspaceEdit. Source or context changes make acceptance stale and preserve the
draft.

Settings:

- `slate.llama.endpoint` (default `http://127.0.0.1:8080`)
- `slate.llama.model` (request label; no model picker or cloud fallback)
- `slate.llama.contextWindow`
- `slate.llama.outputTokens`
- `slate.llama.timeoutSeconds`

See `DEMO.md` at the repository root for the included playable project.
