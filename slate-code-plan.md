---
tags: [project, slate, slate-code, plan, code-mode, vscode-extension, local-models]
---

# slate-code: feature plan

## Context

Slate is a graph-based AI notebook editor — Project → Doc → Card, with explicit `@card` references for context. It's a Vite-built HTML/JS/CSS app that calls OpenAI from the browser.

We want slate to also be a **coding companion**: cards that hold Python definitions, docs that compile into `.py` files, a model toggle so a local Qwen 30B can write the code while Claude/OpenAI handle discussion, and a VS Code extension so this all lives next to the workspace it's writing into. The goal is "architect the code in slate, run it in VS Code." Slate compiles to disk; VS Code runs.

Same codebase. Just a new card type and a model picker.

## Approach (decisions locked in)

- **New card type**, not new doc type. Card gains `cardType: 'markdown' | 'code'`. Docs are heterogeneous — code cards and markdown cards can coexist in one doc. Compile = "emit a `.py` from this doc's code cards in order."
- **Mode toggle = card-level**, not app-level. The "code mode" is just a button on the prompt input that sets `cardType: 'code'` for the next generation. No global mode flag.
- **Model routing by card type**. Code cards default to local Ollama / Qwen 30B. Markdown cards default to current cloud provider (OpenAI / Gemini). User overrides in the settings modal.
- **Run = out of scope**. Compile writes `<doc_title>.py` to the workspace via the VS Code extension; user runs/debugs with VS Code's existing Python tooling.
- **VS Code extension wraps the existing Vite bundle** as a webview. Extension host owns `vscode.workspace.fs` for file writes and `globalState` for settings.

## Files to modify

- **`src/cards.js:13-25`** — Add `this.cardType = 'markdown'` constructor default; persist in `toJSON`. In `create()` (line 27-81), branch on `cardType === 'code'`: render the response in a read-only CodeMirror block with Python syntax highlighting instead of `marked.parse(content)`. Add `getPythonSource()` that strips ```python``` fences from `this.content`.
- **`src/doc.js:7-17,154-171,178-end`** — Add `compileToPython()` method: filter `this.cards` where `cardType === 'code'`, compute import header from cross-doc `@references` in their prompts, concatenate sources in array order. Round-trip `cardType` through `toJSON`/`fromJSON` (per-card; backward-compat default `'markdown'`).
- **`src/ai_utils.js:1-89`** — Extract a duck-typed agent shape (`hasApiKey`, `generateResponse`, `generateSummary`, `updateApiKey`). Add `LocalAgent` class mirroring `OpenAIAgent` but constructed with `new OpenAI({ baseURL, apiKey: 'local', dangerouslyAllowBrowser: true })`, model name from settings (default `qwen2.5-coder:30b` or whatever Ollama tag we run). The Gemini parallel at lines 104-158 already proves the multi-provider pattern works.
- **`src/main_script.js:408-417`** — Extend `getAgentForProvider()` with a `'local'` branch returning `new LocalAgent(baseUrl, modelName)`. In the call site that asks for an agent, route based on `cardType`: code cards → `'local'`, markdown cards → existing provider.
- **`src/main_script.js:419-490`** (settings modal) — Add three fields: provider for code (`local` default), `local_base_url` (default `http://localhost:11434/v1`), `local_model_name` (default `qwen2.5-coder:30b`). Persist to `localStorage` in browser; in VS Code the state-bridge shim transparently writes through to `globalState`.
- **`src/ai_chat.js:311-395`** — When the active prompt is targeting a code card, swap the system prompt to "Output only valid Python source — no markdown fences, no commentary. The output will be saved as `<card_title>` in `<doc_title>.py`." `buildBibliography` (lines 112-178) emits referenced code cards as `# from <doc>: <title>\n<source>` comments rather than markdown.
- **`src/codemirror_setup.js:200-243`** — `setupCodeMirrorEditor()` accepts a `language` param. Push `python()` extension for code-card prompts. Keep the `@`-reference highlighter (lines 111-138) — references work identically; they become `from x import y` at compile time.
- **`src/index.html`** — Add a "Code" toggle next to the SEND button to flag the next generation as a code card. Add a "Compile" button on each doc.
- **`dist/index.html:8-12`** — Strip Google Fonts / Material Symbols CDN links; bundle locally. Required for VS Code webview CSP. Harmless in browser.

## New files

- **`src/code_compile.js`** — `compileDocToPython(doc, project) → { filename, source }`. Filters code cards, builds import header from cross-doc `@references`, deduplicates imports, joins sources with two blank lines between. Sanitizes card titles to valid Python identifiers (snake_case; reject titles with digits-leading or symbols at card-creation time).
- **`src/host_bridge.js`** — `saveCompiled({ filename, source })`. Detects host via `window.acquireVsCodeApi`. In VS Code: `postMessage({ type: 'compile', filename, source })`. In browser: `URL.createObjectURL` + synthesized `<a download>` click.
- **`vscode-extension/package.json`** — Extension manifest. Three commands: `Slate: Open Panel`, `Slate: Compile Current Doc`, `Slate: Toggle Code Card`.
- **`vscode-extension/src/extension.ts`** — `activate()` registers commands; `SlatePanel` class loads `dist/` with `retainContextWhenHidden: true`; `webview.onDidReceiveMessage` handles `compile` (writes `<workspaceRoot>/<docTitle>.py` via `vscode.workspace.fs.writeFile`, validates URI is inside workspace, prompts on overwrite), `read-state` / `write-state` (proxies to `context.globalState`).
- **`vscode-extension/src/state-bridge.ts`** — Injected at webview load. Monkeypatches `localStorage.getItem/setItem` to round-trip through `postMessage` ↔ `globalState`, so settings persist across VS Code restarts without bespoke UI plumbing.

## Sequencing (each phase ships standalone)

1. **Local agent.** `LocalAgent` in `ai_utils.js`, `'local'` branch in `getAgentForProvider`, settings modal extension. Default `qwen2.5-coder:30b` at `http://localhost:11434/v1`. *Validate*: with Ollama running, generate a current-style markdown card using local — confirm both providers still work side-by-side. *Risk*: Ollama CORS — document the `OLLAMA_ORIGINS=*` env var.
2. **Code card type.** `cardType` field on Card, JSON round-trip, code-mode toggle in the prompt UI, Python syntax highlighting on the prompt editor and on rendered code cards. No compile yet — code cards just look like code. *Validate*: old project files load with `cardType: 'markdown'` defaulted, new code cards round-trip through save/load.
3. **Code-aware generation + auto-routing.** `ai_chat.js` branches system prompt on `cardType`, routes to local provider for code cards, post-processes to strip markdown fences in `Card.getPythonSource()`. *Validate*: a code card whose prompt references `@helper_fn` (another code card) produces source that uses `helper_fn` correctly.
4. **Compile to Python.** `src/code_compile.js`, "Compile" button per doc, browser-only flow downloads the `.py`. *Validate*: a 3-card doc with one cross-doc `@reference` produces a syntactically valid `.py` that imports correctly. *Risk*: card titles aren't valid Python identifiers — sanitize at creation time, block invalid renames in `main_script.js:390-405`.
5. **VS Code extension shell + file-write bridge.** `vscode-extension/`, webview hosts the Vite bundle (CSP fix: inline fonts), state-bridge for `globalState`, host wires the `compile` message to `workspace.fs.writeFile`. *Validate*: extension loads, slate UI works inside VS Code, settings persist across restarts, hitting Compile drops a `.py` into the workspace and VS Code's Python tooling picks it up. *Risk*: webview reload loses unsaved state — set `retainContextWhenHidden: true`; document the memory cost.

## Verification (end-to-end)

- **Phase 1–4 (browser)**: `npm run dev` in slate. Smoke: notebook flow unchanged; new code-card flow generates Python via Qwen with `OLLAMA_HOST=http://localhost:11434 ollama serve` running; compile button downloads a `.py` whose `python3 -m py_compile` exits clean.
- **Phase 5 (VS Code)**: from `vscode-extension/`, `npm run watch` + F5 launches the Extension Development Host. Open a workspace, run `Slate: Open Panel`, repeat the smoke flow, hit Compile, confirm the file lands in the workspace, hit VS Code's Run Python File and the script executes.
- **Backward compat**: load an existing exported slate project JSON (no `cardType` anywhere) — every card defaults to `'markdown'`; no UI regression vs. main today.

## Out of scope (v2 candidates)

- Executing code inside slate (Pyodide / subprocess). VS Code runs the file.
- Transitive `@reference` resolution / dead-import cleanup. v1 only handles direct one-card-references-one-card.
- Multi-language. Python only.
- Per-doc model overrides. Provider toggle is global per card type.
- Streaming responses. Slate doesn't stream today; not a code-mode regression.

## Risks

- **Markdown leakage in generated code** — local models often ignore "no fences." Always strip in `getPythonSource()`; never trust the raw `content`.
- **CSP in VS Code webview** — every CDN reference in `dist/index.html` and inline event handler must be removed/inlined. Use a strict `Content-Security-Policy` meta tag.
- **localStorage ↔ globalState shim correctness** — the state bridge has to handle async (`globalState` is async, `localStorage` is sync). Cache the last-known state in-memory in the webview so reads stay sync; flush writes async.
- **Title→identifier collisions** — two cards titled "helper" in different docs would compile to clashing imports. Compiler must namespace by doc (`from doc_x import helper as helper_x`) or refuse to compile.

## Critical files

- `src/cards.js`
- `src/doc.js`
- `src/ai_utils.js`
- `src/ai_chat.js`
- `src/main_script.js`
- `src/codemirror_setup.js`
- `src/index.html`
- `dist/index.html` (CSP scrub)
- `src/code_compile.js` (new)
- `src/host_bridge.js` (new)
- `vscode-extension/` (new)

---

*Related: [motivation](motivation.md) · [readme](readme.md) · [Polaris](../../Polaris.md) · [Threads/Explicit context](../../Threads/Explicit%20context.md) · [Threads/Modularity and codegen](../../Threads/Modularity%20and%20codegen.md)*
