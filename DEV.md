# Dev workflow — slate-code v0.2

This guide gets you running the **VS Code extension** (the v0.2 code-mode
surface) with hot-reload of both the slate webview and the extension TS,
so you can iterate on issues from [issues.md](issues.md) and see changes
immediately.

## One-time setup

```bash
# 1. From slate repo root
npm install
npm run build                          # produces dist/ (the slate webview bundle)

# 2. Then in the extension folder
cd vscode-extension
npm install
cd ..

# 3. Verify the symlink that wires extension → slate dist
ls -la vscode-extension/dist
# expected: vscode-extension/dist -> ../dist
```

The symlink is the key piece: the extension serves its webview from
`vscode-extension/dist/`, which now points at slate's root `dist/`. Any
rebuild of slate flows straight into the extension with no copy step.

If for any reason the symlink is missing (e.g. on Windows; `ln -s` is
unix-only), recreate from the repo root with:

```bash
rm -rf vscode-extension/dist
ln -s ../dist vscode-extension/dist
```

On Windows: use `mklink /D vscode-extension\dist ..\dist` from cmd as Admin,
or fall back to `cd vscode-extension && npm run sync-dist` after every
slate rebuild (manual, no hot-reload).

---

## The dev loop (3 terminals + VS Code)

### Terminal A — slate webview (Vite watch)

```bash
# from slate repo root
npx vite build --watch
```

Watches `src/`, rebuilds `dist/` on any change. Through the symlink, the
extension's webview source updates immediately. Initial build takes ~2-5
seconds; incremental builds are sub-second.

### Terminal B — extension TS (tsc watch)

```bash
# from slate repo root
cd vscode-extension
npm run watch
```

Watches `vscode-extension/src/`, rebuilds `vscode-extension/out/`. Required
when changing `extension.ts` (the host bridge, command handlers, terminal
hand-off, etc.).

### Terminal C — llama.cpp (for local code generation)

```bash
npm run demo:llama
```

The extension host—not the webview—calls llama.cpp's OpenAI-compatible
`/v1/chat/completions` endpoint. The first run downloads the small default
coding GGUF. See [DEMO.md](DEMO.md) for the complete flow.

### VS Code — Extension Development Host

1. Open the **`vscode-extension/`** folder in VS Code (open it as the
   workspace root, not the slate repo root).
2. Press `F5` (or Run → Start Debugging). This launches a second VS Code
   window with the extension loaded — the **Extension Development Host**.
3. In the host window:
   - Click the slate icon in the activity bar (left sidebar) to open the
     slate panel, OR
   - `Cmd+Shift+P` → `Slate: Open Python Harness`, OR
   - Open any `*.slate.json` file (e.g.
     `examples/llama_demo/llama-demo.slate.json`).

### Reloading after changes

- **Harness webview changes** (`src/harness/*`, `src/harness.html`):
  Vite rebuilds → in the host window, run `Developer: Reload Webviews`
  (or `Cmd+R` to reload the whole window).
- **Extension TS changes** (`vscode-extension/src/*.ts`):
  tsc rebuilds → in the host window, `Developer: Reload Window` (`Cmd+R`).
  Webviews-only reload won't pick up extension code changes.

Tip: keep the host window's `Developer Tools` open (`Help → Toggle
Developer Tools`) to see webview console logs and inspect the slate UI.

---

## Browser-only dev (no VS Code)

For pure canvas iteration without VS Code:

```bash
# from slate repo root
npm run dev
```

Vite dev server with HMR; opens `http://localhost:5173/harness.html?demo`
with a built-in demo snapshot (no host, so host actions are inert).

The frozen legacy notebook lives in `legacy/` and runs with
`npm run legacy:dev`.

---

## Where things live

| What | Where | Notes |
|---|---|---|
| Harness webview source | `src/harness/` | React + TypeScript, vite-built |
| Harness built bundle | `dist/` | Vite output; symlinked into extension |
| Extension host code | `vscode-extension/src/extension.ts` | TS, tsc-built |
| Extension built JS | `vscode-extension/out/` | tsc output |
| Extension webview src | `vscode-extension/dist/` → `../dist` | symlink |
| llama.cpp demo | `examples/llama_demo/` | v2 annotations |
| Legacy notebook | `legacy/` | frozen; GitHub Pages only |
| Spec | `SLATE_HARNESS_PLAN.md` | source of truth |
| Open work | `issues.md` | active ordered slices |
| Inventory | `features.md` | shipped / partial / not started |

---

## Common snags

- **"Webview blank / fonts missing"** → CSP issue. Check `dist/harness.html`
  has no `<link>` to external CDNs; extension assets should be bundled.
- **"llama.cpp is unreachable"** → run `npm run demo:llama`, then verify
  `slate.llama.endpoint` is `http://127.0.0.1:8080`.
- **"The candidate was rejected"** → Slate only accepts one parseable function
  with the existing name and signature. The draft stays visible for review.

---

## Suggested loop while implementing an issue

1. Open [issues.md](issues.md) → pick the next unblocked issue.
2. In a new branch: `git checkout -b issue-N-short-name`
3. Read its `Files` list, make changes.
4. Vite + tsc auto-rebuild; reload host window to verify.
5. When acceptance criteria pass: move the issue's block to
   [features.md](features.md) with the `**Resolved:**` line.
6. Commit with a message that references the issue number, e.g.
   `#1 add kind field to Card with migration shim`.

---

*Related: [issues.md](issues.md) · [features.md](features.md) ·
[SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)*
