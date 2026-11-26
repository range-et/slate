# Slate

Slate is a visual node canvas and Two-Tier build harness for composing software. Raw code lives only inside bounded atomic function nodes (`<= 60` lines with explicit types and contracts). Higher-level logic is wired as deterministic flow graphs and compiled directly into standard source modules without generative glue code.

- **Shipped inventory:** [features.md](features.md)
- **Architecture & plan:** [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)
- **Why Slate exists:** [docs/motivation.md](docs/motivation.md)
- **Development loop:** [DEV.md](DEV.md)
- **Backlog & issues:** [GitHub Issues](https://github.com/range-et/slate/issues)

## How Slate Works

1. **Atomic Library Units (`slate/nodes/**/*.json`):** Each unit holds one function, class, or prelude block constrained by JPL-60 (`<= 60` lines, typed inputs and return annotation, intent, contract, structured cases, and checks).
2. **Deterministic Flows (`slate/flows/**/*.json`):** Functions connect through typed ports and wires, including `branch`, `foreach`, and `repeat` control regions. Slate compiles flows directly to native modules.
3. **Two-Tier AI Division of Labor:**
   - **Tier 1 — Frontier Architect (MCP):** Connects over the Model Context Protocol (`vscode-extension/out/mcp/slate_mcp_server.js`) to search nodes, place canvas notes, pan the canvas camera, define typed stubs (`slate_define_stub`, no body code allowed), wire flows, and trigger batch forging.
   - **Tier 2 — Component Forge (HTTP):** Receives bounded micro-packets (`<= 600` input tokens, `1536` default output tokens) over OpenAI-compatible HTTP SSE (`llama.cpp`, Ollama, LM Studio, or OpenRouter) and writes each bounded body plus unit check, verified automatically.

## Language Support

| Language | Parse & Edit | Flow Compile | Tier 2 Batch Forge & Per-Node Verification |
|---|---|---|---|
| **Python** | Lezer AST | Deterministic `.py` modules + `def main()` + Live Run preview | Yes — Pydantic strict contracts + `pytest` (+ `mutmut` on Linux/WSL) |
| **TypeScript / JS / TSX / JSX** | TypeScript Compiler AST | Deterministic `.ts`/`.tsx`/`.js`/`.jsx` modules | Yes — strict `tsc` typecheck + isolated Node `.cjs` test runner |
| **C#, C++ / Arduino** | Language adapters & importers | Deterministic `.cs` / `.cpp` / `.ino` output | Porting, JPL-60 checks, and compiling only (no per-node automated test loop) |
| **Prose** | Structured section/citation/rubric operators | Deterministic `.md` and `.tex` documents + bibliography | Word/char budgets, required citations, forbidden terms, rubric checks |

---

## Install With an AI Agent

Paste the instruction below into Claude Code, Cursor, Codex, Antigravity, or Gemini CLI. Ask it either to install both the VS Code extension and MCP server, or only the headless MCP build.

```text
Set up Slate from https://github.com/range-et/slate.git for my workspace:
1. Check prerequisites: Node.js >= 20, Python 3.10+ with `pytest` and `pydantic`, and the VS Code `code` CLI (for VSIX installation).
2. Clone the repository with submodules (`git clone --recurse-submodules https://github.com/range-et/slate.git`) into a local tools folder (for example ~/tools/slate), or pull `main` and run `git submodule update --init --recursive` if already present (required for `design-tokens/` CSS/JS build assets), then run `npm ci` at root and `npm ci --prefix vscode-extension`.
3. Install the VS Code extension and verify everything:
   - Full verified VSIX install (runs the launch gate first; requires `npx playwright install chromium`):
     `npm run package-extension -- --install`
   - Or fast build for headless MCP + extension TypeScript without running Playwright/Electron QA:
     `npm run build && npm --prefix vscode-extension run sync-dist && npm --prefix vscode-extension run compile`
     (then optionally package VSIX with `npm --prefix vscode-extension exec vsce package -- --allow-missing-repository --skip-license --follow-symlinks` and install via `code --install-extension`).
4. Verify the MCP server binary responds to tool discovery:
   `node <path-to-slate>/vscode-extension/out/mcp/slate_mcp_server.js --workspace "<path-to-target-project>" --list-tools`
5. Register `slate` in my MCP client configuration running `node` with `["<path-to-slate>/vscode-extension/out/mcp/slate_mcp_server.js", "--workspace", "<path-to-target-project>"]` (and pass `OPENROUTER_API_KEY` or `SLATE_LLM_API_KEY` in `env` if using a remote endpoint).
6. Do not put raw API keys inside `slate/slate.json`. Reload VS Code after installing the VSIX.
```

---

## Manual Install and Setup

### Prerequisites

- **Node.js `>= 20`** and `npm`
- **Python `3.10+`** with `pytest` and `pydantic` (`pip install pytest pydantic`)
- **VS Code `code` CLI** in `PATH` (for VSIX installation)
- **Playwright Chromium** (`npx playwright install chromium`) if running `npm run verify:launch` or `npm run package-extension`
- **Initialized `design-tokens` submodule** (included automatically by `--recurse-submodules`; for existing clones, run `git submodule update --init --recursive`)

### Option A: Verified VSIX Build and Install (VS Code Extension + MCP)

`package-extension` runs the full `npm run verify:launch` suite before building and installing the VSIX. If upgrading an existing checkout without submodules initialized, run `git submodule update --init --recursive` before installing dependencies:

```bash
git clone --recurse-submodules https://github.com/range-et/slate.git
cd slate
npm ci
npm ci --prefix vscode-extension
npx playwright install chromium
npm run package-extension -- --install
```

On Linux headless servers, install Playwright system dependencies and wrap X11 if running QA:

```bash
npx playwright install --with-deps chromium
xvfb-run -a npm run package-extension -- --install
```

After installation finishes, run **Developer: Reload Window** inside VS Code.

### Option B: Fast Build (Headless MCP or Local Compile)

If you only need the standalone MCP server bundle (`vscode-extension/out/mcp/slate_mcp_server.js`, which runs without `node_modules` at runtime) or want to package without running Playwright/Electron QA:

```bash
git clone --recurse-submodules https://github.com/range-et/slate.git
cd slate
npm ci
npm ci --prefix vscode-extension
npm run build
npm --prefix vscode-extension run sync-dist
npm --prefix vscode-extension run compile
```

Verify the MCP server lists all 11 tools (`slate_find`, `slate_focus`, `slate_place_notes`, `slate_references`, `slate_define_stub`, `slate_wire_flow`, `slate_compile`, `slate_verify_ci`, `slate_llm_status`, `slate_configure_llm`, `slate_forge_batch`):

```bash
node vscode-extension/out/mcp/slate_mcp_server.js --workspace /path/to/your/project --list-tools
```

### Connect Your AI Client via MCP

Add a stdio MCP server entry in your agent client (Claude Code, Cursor, Antigravity, Gemini CLI, etc.):

```json
{
  "mcpServers": {
    "slate": {
      "command": "node",
      "args": [
        "/absolute/path/to/slate/vscode-extension/out/mcp/slate_mcp_server.js",
        "--workspace",
        "/absolute/path/to/your/project",
        "--trust-workspace"
      ],
      "env": {
        "OPENROUTER_API_KEY": "optional-if-using-openrouter"
      }
    }
  }
}
```

- **MCP trust and LLM pairing flags:** Pass `--trust-workspace` (or set `SLATE_TRUST_WORKSPACE=1`) for trusted workspaces so verification and configured LLM endpoints can execute (untrusted workspaces fail closed). To permit project-configured endpoints + credentials in headless CLI/MCP sessions, pass repeatable `--approve-llm-pairing "<normalized-endpoint>|<env:VAR|secret-storage>"` flags.
- **Live camera bridge:** When the VS Code canvas panel is open, live `/focus` camera sync stores an authenticated, session-scoped bridge record in the user-private runtime directory (never inside the repository) using the `x-slate-bridge-token` header.

### Configure a Tier 2 Model

Slate does not ship a bundled model binary. Configure an endpoint in VS Code Settings (`slate.llama.*`), `slate/slate.json` (`llm`), or via the `slate_configure_llm` MCP tool.

- **Local `llama.cpp` (`llama-server`):**

  ```bash
  llama-server --model Qwen3-Coder-30B-A3B.gguf --port 8080 --ctx-size 4096 --n-gpu-layers 99
  ```

- **Local Ollama:** endpoint `http://127.0.0.1:11434/v1`, provider `ollama`.
- **OpenRouter (or remote OpenAI-compatible HTTP):** set `provider: "openrouter"`, `apiKeyEnv: "OPENROUTER_API_KEY"`, and a `model` such as `qwen/qwen3-coder-next` (default OpenRouter preset in the Canvas LLM modal), `qwen/qwen3-coder-30b-a3b-instruct`, or `google/gemma-4-26b-a4b-it`. Slate rejects raw secrets inside `slate/slate.json` and reads keys only from process environment variables or VS Code `SecretStorage`.

Example `slate/slate.json` snippet:

```json
{
  "slate": 3,
  "name": "my_project",
  "language": "python",
  "llm": {
    "provider": "llama.cpp",
    "endpoint": "http://127.0.0.1:8080",
    "model": "qwen3-coder",
    "concurrency": 3,
    "outputTokens": 1536,
    "contextWindow": 4096
  }
}
```

---

## Use Slate on Another Project

1. **New project in VS Code:** Open an empty or target folder in VS Code and run **Slate: New Project**. To import existing code without modifying original files, run **Slate: Port Python Project…** or **Slate: Port Project (Any Supported Language)…**.
2. **Drive via Two-Tier MCP loop:** Point your frontier agent at the workspace using `slate_mcp_server.js`, ask it to define typed stubs and test cases (`slate_define_stub`), forge all stubs in topological dependency waves (`slate_forge_batch`), wire data flows (`slate_wire_flow`), and compile (`slate_compile`).
3. **Compile safely:** Slate writes only generated modules containing Slate headers and refuses to overwrite hand-written files outside `slate/`.

### Current Practical Limits to Know

- Canvas UI supports concurrent per-unit generation and topbar **⚒ Forge Stubs** (`1`–`16` parallel requests) alongside MCP `slate_forge_batch`; multi-wave verification loops continue to require a trusted workspace.
- Class methods stay inside class units rather than splitting into individual method nodes ([Issue #16](https://github.com/range-et/slate/issues/16)).
- Per-node runtime test verification is shipped for Python and TypeScript/JavaScript; C# and C++/Arduino support porting, checks, and compiling only.
- On native Windows, `mutmut` mutation testing is skipped with an explicit diagnostic (requires Linux or WSL).

---

## Development, Benchmarks, and Verification

```bash
npm test                  # Vitest unit suites
npm run build             # Vite build -> dist/
npm run verify:contracts  # 4-pillar contract & CI check on example projects
npm run verify:ci -- --workspace /path/to/project --require-tests  # Standalone 4-pillar CI CLI
npm run verify:baseline   # Static checks + tests + mutation + contract + example round-trips
npm run verify:launch     # Full launch gate (verify:baseline + Playwright + Extension Host + Workbench QA)
npm run demo:llama        # Local llama.cpp demo loop (see DEMO.md)
```

For external repositories (such as scientific Python or PyTorch codebases), configure optional `pythonPath` (e.g. `".venv/bin/python"`) and `ci: { "srcRoots": ["pkg"], "testRoots": ["tests"], "requireTests": true }` in `slate/slate.json`, and call the reusable GitHub Actions template [`.github/workflows/slate-ci.yml`](.github/workflows/slate-ci.yml).

Run the automated Two-Tier offload benchmark (offline `fake` or live provider):

```bash
npm run benchmark:offload -- --spec benchmarks/specs/sci_calc.json --provider fake
npm run benchmark:offload -- --spec benchmarks/specs/sudoku.json --provider fake
```

## License

Slate uses a dual-license model:

- **Software and source code:** [PolyForm Noncommercial License 1.0.0](LICENSE.md#1-software-code--polyform-noncommercial-license-100)
- **Graphics, branding, and documentation:** [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](LICENSE.md#2-graphics-branding--documentation--cc-by-nc-40) (Indrajeet Haldar)

See [LICENSE.md](LICENSE.md) for complete terms.
