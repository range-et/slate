---
tags: [project, slate, slate-code, dev, hot-reload]
---

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

### Terminal C — Ollama (for local code generation)

```bash
# allow webview origin to talk to Ollama
OLLAMA_ORIGINS=* ollama serve

# in another shell (or just leave it loaded)
ollama pull qwen2.5-coder:7b              # smaller, faster for dev
# (production target is qwen2.5-coder:30b — switch in slate settings)
```

Skip this terminal if you're working on UI / schema / compile pieces that
don't need the model.

### VS Code — Extension Development Host

1. Open the **`vscode-extension/`** folder in VS Code (open it as the
   workspace root, not the slate repo root).
2. Press `F5` (or Run → Start Debugging). This launches a second VS Code
   window with the extension loaded — the **Extension Development Host**.
3. In the host window:
   - Click the slate icon in the activity bar (left sidebar) to open the
     slate panel, OR
   - `Cmd+Shift+P` → `Slate: Open Empty Panel`, OR
   - Open any `*.slate.json` file (e.g. once #28 ships,
     `examples/tic_tac_toe/tic_tac_toe.slate.json`).

### Reloading after changes

- **Slate src changes** (`src/*.js`, `src/*.css`, `src/index.html`):
  Vite rebuilds → in the host window, run `Developer: Reload Webviews`
  (or `Cmd+R` to reload the whole window).
- **Extension TS changes** (`vscode-extension/src/*.ts`):
  tsc rebuilds → in the host window, `Developer: Reload Window` (`Cmd+R`).
  Webviews-only reload won't pick up extension code changes.

Tip: keep the host window's `Developer Tools` open (`Help → Toggle
Developer Tools`) to see webview console logs and inspect the slate UI.

---

## Browser-only dev (no VS Code)

For markdown-notebook work or pure UI iteration that doesn't need
extension features, the original flow still works:

```bash
# from slate repo root
npm run dev
```

Vite dev server with HMR; opens at `http://localhost:5173`. Code-mode UI
will be hidden once issue **#31** lands (the `isCodeHost()` gate).

---

## Where things live

| What | Where | Notes |
|---|---|---|
| Slate UI source | `src/` | Vanilla JS, vite-built |
| Slate built bundle | `dist/` | Vite output; symlinked into extension |
| Extension host code | `vscode-extension/src/extension.ts` | TS, tsc-built |
| Extension built JS | `vscode-extension/out/` | tsc output |
| Extension webview src | `vscode-extension/dist/` → `../dist` | symlink |
| State bridge (localStorage ↔ globalState) | `vscode-extension/src/state-bridge.js` | injected into webview |
| Tic-tac-toe scaffold | `examples/tic_tac_toe/` | CI gate per issue #28-#30 |
| Spec | `slate-code-v0.2-spec.md` | source of truth |
| Open work | `issues.md` | 36 issues across 10 phases |
| Shipped work | `features.md` | append-only resolved log |

---

## Common snags

- **"Webview blank / fonts missing"** → CSP issue. Check `dist/index.html`
  has no `<link>` to external CDNs (Google Fonts etc.); they should be
  bundled. v0.1 already scrubs them; if it regresses, see
  `slate-code-plan.md` risk #2.
- **"Settings don't persist across reload"** → state-bridge mismatch.
  Check `state-bridge.js` is being injected and `globalState` writes are
  flushing.
- **"Local model returns markdown fences anyway"** → expected; the
  defensive strip in `Card.getPythonSource()` (and post-#5, the
  `python.system.txt` system prompt + parser) handles this.
- **"Terminal hand-off does nothing"** → that lands in issue **#20**;
  not implemented yet.

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
[slate-code-v0.2-spec.md](slate-code-v0.2-spec.md)*
