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

## Canvas, references, and flows

Every node shows typed ports (one input per parameter, one output). Wire an
output to an input to describe dataflow; wires on the main canvas are stored
in `slate/flows/main.json` and compile to `def main()`. Drag from a node's
bottom edge to another node's top edge to give it context instead.

The left **Library** lists nodes by folder, flows, and read-only library
files (`slate.json` → `library`). Drag an item onto the canvas to place a
reference (an alias with the same ports). Press **Tab**, **Shift+A**, or
double-click empty canvas to add a node at the cursor; drop a wire on empty
canvas to add a node of a matching type, already wired. Placeholders are
names you can later turn into a reference or a new node.

Select some nodes and press **Ctrl/Cmd+G** to group them into a flow
(`slate/flows/<name>.json`): crossing wires become its inputs and outputs.
Double-click a flow (or press Tab) to open it; the breadcrumb returns. Flows
compile to plain Python functions. **Map** shows nodes grouped by folder.

## Port and compile

**Slate: Port Python Project…** picks a folder and splits it into node files
under `slate/nodes/` (the source folder is never modified). Module `a/b.py`
becomes folder `a/b/`; each top-level function or class becomes a node with
only the imports it uses, and references to other ported names are recorded
as `uses`. Other module-level statements become a `_prelude` node (runs before
the nodes) and an `_epilogue` node (runs after, e.g. the `__main__` guard).
The port report opens in **Output → Slate**.

**Describe nodes with llama.cpp** (Cmd+K) asks the local model for a one-line
intent per undescribed node, leaves first, sending only that node's code plus
the signatures and intents of the nodes it uses. Runs are resumable and can be
stopped from the palette.

**Slate: Compile Project** (also on Cmd+K) writes one Python module per node
folder into `compile.outDir` (default `src/`): merged imports, cross-module
imports for `uses`, and a `# slate: nodes/<id>` stamp plus intent and
contract comments on every block. Any compile error stops the write; stale
generated files are removed, hand-written files are kept.

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
