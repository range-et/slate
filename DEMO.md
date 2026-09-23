# Slate llama.cpp demo

This demo exercises the source-linked loop: select a function, inspect its
exact context packet, stream a local implementation, review the confined
proposal, accept it as one VS Code edit, and undo it.

## Start it

```bash
# Terminal 1 — starts llama.cpp. First run downloads a 491 MB coding GGUF.
npm run demo:llama

# Terminal 2 — build, package, and install the extension.
npm run package-extension -- --install
```

Reload VS Code, then open this folder and open
`examples/llama_demo/llama-demo.slate.json`. Select `normalize_score` in the
graph. Its workbench shows `clamp` as named required context and the exact token
budget. Click **Generate with llama.cpp**, inspect the candidate and structural
checks, then **Accept WorkspaceEdit**. **Undo accepted edit** uses VS Code's
native undo after revealing the current function.

To start with an existing Python project, open its folder in VS Code and run
**Slate: Scan Python Workspace** from the Command Palette. Slate creates a
`.slate.json` project beside the source and opens the board. Two-finger scroll
pans the board and pinch zooms it. Right-click empty space to create a board
note, or right-click a function to attach a note to its durable identity. These
notes and their positions live in Slate metadata; they never modify Python.

The endpoint defaults to `http://127.0.0.1:8080`. Change it under
`slate.llama.endpoint` if needed. Slate has no model picker and no cloud
fallback.
