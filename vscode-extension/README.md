# Slate Code (VS Code extension)

Hosts the slate notebook UI in a VS Code webview, and writes compiled `.py` files into your workspace.

> Architect the code in slate. Run it in VS Code.

## What you get

- **`*.slate.json` files open in slate.** Double-click any `.slate.json` in your workspace and VS Code routes it to the slate custom editor instead of the JSON viewer. Edits round-trip through VS Code's standard dirty/save flow.
- A **Slate icon in the activity bar**. The sidebar offers two buttons: **New Slate Project…** (prompts for a name and creates `<name>.slate.json` in the workspace) and **Open Empty Panel** (an unbound, ephemeral slate panel).
- **Compile alongside the source.** Compile from a `.slate.json`-backed editor and the `<doc>.py` lands next to the source file. Compile from the empty panel and it lands at the workspace root.
- **Commands**: `Slate: New Project…`, `Slate: Open Empty Panel`, `Slate: Compile Current Doc`, `Slate: Toggle Code Card`.

`localStorage` (API keys, provider choice, local model name, base URL) is shimmed onto VS Code `globalState`, so your settings persist across restarts.

## Develop

From the slate repo root:

```bash
npm install
npm run build              # builds dist/

cd vscode-extension
npm install
npm run sync-dist          # wipes & syncs ../dist into ./dist (avoids nesting on re-run)
npm run compile            # compiles extension TS
```

Then press **F5** with `vscode-extension/` open in VS Code. An Extension Development Host launches; double-click any `*.slate.json` in your workspace, or use the Slate icon in the activity bar.

**Iteration loop**: after editing slate source, run `npm run build` (slate root) + `npm run sync-dist` (extension), then **Cmd+R** the dev host webview.

## Permanent install (build once, install as a real extension)

From the slate repo root:

```bash
npm run package-extension -- --install   # build, package, install via `code` CLI
npm run package-extension                # build + package only; prints the install command
```

This script stubs `src/config.js` (so your local OpenAI/Gemini keys never get baked into the bundle), runs the full build + sync + `vsce package`, and restores your config — even if anything fails partway. The `.vsix` lands at `vscode-extension/slate-code-<version>.vsix`.

After installing, run **Developer: Reload Window** in VS Code to pick up the new build.

A symlink also works instead of `sync-dist`:

```bash
ln -s ../dist vscode-extension/dist   # one-time, then `npm run build` is enough
```

## Smoke flow

1. With Ollama running locally (`OLLAMA_ORIGINS='*' ollama serve`), open Slate and pick **Local (Ollama)** in the API key modal. Default tag: `qwen2.5-coder:30b`.
2. Click **CODE** to flip into code-card mode.
3. Type a prompt that references other cards via `@name`, hit **SEND**.
4. **ADD TO DOC** to commit the result as a code card.
5. **COMPILE** to write `<doc_title>.py` into your workspace.
6. Open the file in VS Code and run it with the existing Python tooling.

## Notes

- Slate runs entirely client-side. The extension only writes files; it doesn't proxy LLM calls.
- The webview's CSP allows Google Fonts (used by the design system) and connections to `localhost:*` (Ollama), `api.openai.com`, and `generativelanguage.googleapis.com`.
- If `dist/` is missing inside the extension, opening the panel will surface a helpful error explaining how to populate it.
