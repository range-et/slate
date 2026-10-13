# Slate llama.cpp demo

This demo exercises the node loop on a `slate/` folder: select a node, edit
its intent and code in the workbench, inspect its exact context packet, stream
a local implementation, review it, accept it into the node JSON, and undo it.

## Start it

```bash
# Terminal 1 — starts llama.cpp. First run downloads a 491 MB coding GGUF.
npm run demo:llama

# Terminal 2 — build, package, and install the extension.
npm run package-extension -- --install
```

Reload VS Code, open the `examples/llama_demo` folder, and open
`slate/slate.json` (it opens in the Slate canvas). The project is plain JSON:

```text
examples/llama_demo/slate/
├── slate.json                 project name, language, compile target
├── layout.json                node positions and board notes
└── nodes/
    ├── clamp.json             locked reference implementation
    └── normalize_score.json   the target; context: clamp
```

- **Click** a node to select it (your editor doesn't move). **Double-click**
  or **Enter** opens the node's JSON file. Press **/** to focus the command
  line.
- Select `normalize_score`. The workbench shows its intent, contract, code
  editor, `clamp` as named context, and the exact token budget.
- Click **Generate with llama.cpp**, inspect the candidate and checks, then
  **Accept WorkspaceEdit**. The candidate is written into the node's `code`.
  **Undo accepted edit** reverts it with VS Code's native undo.
- Edit code directly in the workbench and press **Save code**. Saves are
  rejected unless the code is one definition with the node's name, or if the
  node changed since you started editing.
- Right-click empty canvas → **New node…** asks for a typed signature and an
  intent and creates `slate/nodes/<name>.json` where you clicked. Two-finger
  scroll pans; pinch zooms. Dragging only rewrites `layout.json`.

To start your own project, open a folder and run **Slate: New Project**. It
creates an empty `slate/` folder and opens the canvas.

The endpoint defaults to `http://127.0.0.1:8080`. Change it under
`slate.llama.endpoint` if needed. Slate has no model picker and no cloud
fallback.
