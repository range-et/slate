# Dev workflow — slate-code v0.2

## Required launch gate

Run `npm run verify:launch` before handing off code as launch-ready. It runs the
unit matrices, builds, Python round-trip checks, browser interaction
QA, real VS Code Extension Host tests, and workbench generation/undo/save and
native-dialog tests. Any failed
stage stops the gate. `npm run package-extension` runs this gate before packaging;
Pages deployment also depends on the CI launch gate.

For a focused iteration use `npm test -- test/<file>.test.ts` or
`npm run test:webview -- --grep '<scenario>'`. Run all UI/host QA with
`npm run test:qa`. Install Chromium with `npx playwright install chromium`; on
Linux use `npx playwright install --with-deps chromium` and run the launch gate
under `xvfb-run -a`. Python/pytest and extension dependencies are also required.

Every behavior change must update unit tests and affected interaction-chain
tests in the same change. See [AGENTS.md](AGENTS.md), the
[unit coverage matrix](test/UNIT_TEST_MATRIX.md), and the
[UX/QA interaction matrix](test/UX_QA_MATRIX.md) for the required coverage and
remaining gaps. Repository administrators should require the `Launch gate` CI
check in branch protection.

This guide gets you running the **VS Code extension** (the v0.2 code-mode
surface) with hot-reload of both the slate webview and the extension TS,
so you can iterate on issues from [GitHub Issues](https://github.com/range-et/slate/issues) and see changes
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
   - Open a `slate/slate.json` (e.g. `examples/llama_demo/slate/slate.json`),
     OR
   - `Slate: Port Python Project…` to split an existing Python folder into
     `slate/`, then `Slate: Compile Project` to write it back out to `src/`.

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
with a built-in demo snapshot (no host, so host actions are inert). The
Playwright tests use the same demo.

The landing page lives in `src/index.html` and is served alongside the harness demo.

---

## Where things live

| What | Where | Notes |
|---|---|---|
| Harness webview source | `src/harness/` | React + TypeScript, vite-built |
| Harness built bundle | `dist/` | Vite output; symlinked into extension |
| Landing page source | `src/index.html` | Monad-styled project landing page |
| Extension host code | `vscode-extension/src/extension.ts` | TS, tsc-built |
| Extension built JS | `vscode-extension/out/` | tsc output |
| Extension webview src | `vscode-extension/dist/` → `../dist` | symlink |
| llama.cpp demo | `examples/llama_demo/slate/` | node JSON format |
| Folder format + loader | `vscode-extension/src/slate_folder.ts` | pure; host side in `slate_folder_host.ts` |
| Web showcase | `dist/` | GitHub Pages product showcase and web demo |
| Spec | `SLATE_HARNESS_PLAN.md` | source of truth |
| Open work | [GitHub Issues](https://github.com/range-et/slate/issues) | triage, priorities, dependencies and acceptance criteria |
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

1. Triage [GitHub Issues](https://github.com/range-et/slate/issues), including
   comments and linked PRs. Reproduce bugs, establish acceptance criteria and
   dependencies, then choose the next unblocked item aligned with owner priorities.
2. Work on a `codex/issue-N-short-name` branch (or the branch requested by the owner).
3. Implement the issue completely, with meaningful regression tests and updated
   unit/UX coverage matrices. Use the relevant design and source files.
4. Run focused tests during development and `npm run verify:launch` before handoff.
5. Add the completed behavior to [features.md](features.md), with the date,
   GitHub issue/PR links, validation and any limitations. Keep remaining work on
   GitHub rather than presenting it as shipped.
6. Reference the issue in the commit/PR; use `Closes #N` when the PR satisfies it.
   Close the issue after acceptance criteria are met and the work is merged.

GitHub Issues is the sole backlog. Do not recreate a local issue list.

---

*Related: [GitHub Issues](https://github.com/range-et/slate/issues) · [features.md](features.md) ·
[SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)*
