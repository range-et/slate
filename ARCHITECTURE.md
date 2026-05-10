---
tags: [project, slate, architecture, map, ai-guide]
status: living
audience: humans + AI agents
---

# slate — architecture map

> **Read this before touching code.**
> If your task is "add a button" or "fix a bug in X", this map tells you which
> file owns the change. If it doesn't, the map is wrong — open an issue and
> fix the map.
>
> Companion files: [issues.md](issues.md) (what's left),
> [features.md](features.md) (what shipped),
> [slate-code-v0.2-spec.md](slate-code-v0.2-spec.md) (why).

---

## TL;DR for AI agents

1. **Find the right layer first.** Models hold data. Controllers mutate data.
   Applets render and emit intent. Host bridge talks to the outside world.
   If your change crosses layers, you're probably doing too much in one PR.
2. **Check the capability matrix** in [src/capabilities.js](src/capabilities.js)
   before adding any target-specific UI or behavior. Never write
   `if (isRunningInVsCode())` — add a capability key and gate on `can('foo')`.
3. **Smaller files win.** If a file passes ~400 lines, it's a refactor target.
   Today's offenders are listed in § Hotspots below.
4. **Update this map** when you add, move, or rename modules. The map IS the
   contract.

---

## Mental model

Slate is **one harness, two surfaces**:

```diagram
              ╭──────────────────────────────────╮
              │   slate (single JS bundle)       │
              │                                  │
              │   ╭────────╮ ╭────────────────╮  │
              │   │ Model  │ │  Controllers   │  │
              │   ╰────────╯ ╰────────────────╯  │
              │   ╭───────────────────────────╮  │
              │   │  Applets (views + intent) │  │
              │   ╰───────────────────────────╯  │
              │   ╭───────────────────────────╮  │
              │   │  capabilities.js (matrix) │  │
              │   ╰───────────────────────────╯  │
              │   ╭───────────────────────────╮  │
              │   │  host_bridge.js (target)  │  │
              │   ╰─────────────┬─────────────╯  │
              ╰─────────────────┼────────────────╯
                                │
                ╭───────────────┴────────────────╮
                ▼                                ▼
       ╭────────────────╮              ╭──────────────────╮
       │  Web (browser) │              │  VS Code webview │
       │   GH Pages     │              │  + extension host│
       ╰────────────────╯              ╰──────────────────╯
```

Both targets load the **same bundle**. Behavioral differences are decided at
runtime by `capabilities.js`. The boundary between in-bundle code and the
outside world is `host_bridge.js`.

---

## The four layers

| Layer | Owns | Lives in | Mutates state? | Touches DOM? |
|---|---|---|---|---|
| **Model** | Pure data + invariants | `src/cards.js`, `src/doc.js`, `src/project.js` | yes (self only) | no |
| **Controllers** | Orchestration, dispatch | `src/controllers/*` *(planned)* | yes (via model API) | no |
| **Applets** | Render + emit intent events | `src/applets/*` *(planned)* | no | yes |
| **Host bridge** | Talk to web/vscode | `src/host_bridge.js` | no | no |

Today most controller work lives in [main_script.js](src/main_script.js) and
[ai_chat.js](src/ai_chat.js). Phase B of the refactor splits it out — see
§ Refactor roadmap.

---

## Capability matrix

The full matrix lives in [src/capabilities.js](src/capabilities.js). Summary:

| Capability | web | vscode | Notes |
|---|---|---|---|
| `languages` | markdown, python | markdown, python, csharp, cpp, javascript | Which preset schemas mount |
| `compile.mode` | download | workspace-write | How CompileCtl ships output |
| `localModels` | ✗ | ✓ | CORS blocks Ollama from a browser tab |
| `cloudModels` | ✓ | ✓ | OpenAI/Gemini |
| `streaming` | ✓ | ✓ | Token-by-token render |
| `terminalHandoff` | ✗ | ✓ | `⌘⇧R` paste-block to terminal |
| `workspaceFs` | ✗ | ✓ | `.slate-map.json` sidecar reads/writes |
| `customEditor` | ✗ | ✓ | `.slate.json` as a custom editor |
| `feedbackWidget` | ✓ | ✗ | Web-only |
| `landingTour` | ✓ | ✗ | "Try slate" first-run tour |
| `shareLink` | ✓ | ✗ | Copy-to-share URL |
| `settingsRoute` | localStorage | globalState | Where prefs/api-keys live |

**To add a capability**: edit `src/capabilities.js`, then update this table.

---

## Where things live (the map)

### Model layer (pure data)

| Concern | File | Notes |
|---|---|---|
| Card data + render template | [src/cards.js](src/cards.js) | mid-migration: `cardType` → `language` (issue #9) |
| Doc data + card list | [src/doc.js](src/doc.js) | auto-creates header card on `init()` |
| Project data + targets | [src/project.js](src/project.js) | will gain `targets[]` (spec §1) |
| Card-kind constants | [src/cards.js](src/cards.js) | `CARD_KIND_HEADER/BODY/CLASS` |
| Random doc/card name fallback | [src/random_name_generator.js](src/random_name_generator.js) | |

### Controllers (today: god objects; planned: split out)

| Concern | Today | Planned |
|---|---|---|
| App bootstrap, DOM wiring, dispatch | [src/main_script.js](src/main_script.js) | shrinks as remaining applets land (Phase D) |
| **Prompt assembly, send loop, bibliography, error classification** | [src/controllers/chat_ctl.js](src/controllers/chat_ctl.js) ✓ (view bits in [src/ai_chat.js](src/ai_chat.js)) | `src/applets/prompt_bar/` ✓ owns the bar UI |
| AI provider clients (OpenAI, Gemini, Ollama) | [src/ai_utils.js](src/ai_utils.js) | stays as-is (already a clean adapter layer) |
| **Compile dispatch** | [src/controllers/compile_ctl.js](src/controllers/compile_ctl.js) ✓ | + `src/compilers/index.js` registry in Phase D |
| **Doc lifecycle** (create/remove/switch, summary, title sanitization) | [src/controllers/doc_ctl.js](src/controllers/doc_ctl.js) ✓ | view-side summary modal moves into an applet in Phase C |
| **Project lifecycle** (export/import, search, host notify) | [src/controllers/project_ctl.js](src/controllers/project_ctl.js) ✓ | + command palette applet in Phase C |
| Card lifecycle (rehydrate today; draft/freeze/regenerate per #17/#18/#19) | [src/controllers/card_ctl.js](src/controllers/card_ctl.js) ✓ | freeze ceremony lands here in Phase B follow-ups |

### Applets (today: inlined; planned: extracted)

| Applet | Today's location | Capability gate |
|---|---|---|
| PromptBar (prompt + model + lang + send + stop) | `src/ai_chat.js` | always |
| CardView (header, code, markdown, class) | `src/cards.js` | always |
| NetworkViz (D3 graph) | [src/network_viz.js](src/network_viz.js) | always |
| Modal (alert/confirm/select) | [src/modal.js](src/modal.js) | always |
| CodeMirror editor + autocomplete + highlight | [src/codemirror_setup.js](src/codemirror_setup.js) | always |
| TerminalHandoffBtn | does not exist | `terminalHandoff` |
| FeedbackWidget | does not exist | `feedbackWidget` |
| LandingTour | does not exist | `landingTour` |
| CommandPalette (⌘K) | does not exist | always |

### Compilers + presets (planned)

```diagram
src/
├── compile.js                    (planned — generic dispatcher)
├── compilers/
│   ├── index.js                  (planned — registry)
│   ├── python.js                 (today: src/code_compile.js)
│   ├── csharp.js                 (future, vscode-only)
│   ├── cpp.js                    (future, vscode-only)
│   └── prompts/
│       └── python.system.txt     (planned — issue #5)
└── preset_schemas/
    ├── markdown.js               (planned — system prompt + card schema)
    └── python.js                 (planned)
```

### Host bridge (target IO)

| Concern | File |
|---|---|
| Compile delivery (download vs fs write) | [src/host_bridge.js](src/host_bridge.js) `saveCompiled()` |
| Disk rehydrate (vscode only) | [src/host_bridge.js](src/host_bridge.js) `requestRehydrate()` |
| Generic postMessage to host | [src/host_bridge.js](src/host_bridge.js) `postToHost()` |
| Target detection | [src/capabilities.js](src/capabilities.js) `detectTarget()` |
| VS Code extension entry | [vscode-extension/src/extension.ts](vscode-extension/src/extension.ts) |
| Settings round-trip (localStorage ↔ globalState) | [vscode-extension/src/state-bridge.js](vscode-extension/src/state-bridge.js) |

### Build + config

| Concern | File |
|---|---|
| Vite config + base path | [vite.config.js](vite.config.js) |
| Entry HTML | [src/index.html](src/index.html) |
| API key fallback (gitignored) | [src/config.js](src/config.js) |
| API key loader (localStorage first) | [src/config_loader.js](src/config_loader.js) |
| Pre-build config stub | [scripts/ensure-config.js](scripts/ensure-config.js) |
| GH Pages workflow | [.github/workflows/pages.yml](.github/workflows/pages.yml) |
| Design tokens (submodule) | [design-tokens/](design-tokens/) |
| Legacy palette aliases | [src/slate_palette.css](src/slate_palette.css) |
| App styles | [src/styles.css](src/styles.css) |

---

## Hotspots (refactor targets)

| File | LOC | Why it's a hotspot | Plan |
|---|---|---|---|
| [src/main_script.js](src/main_script.js) | 968 | Bootstrap + walkthrough + host bridge + settings (project/doc/card state extracted in #44; applet mounts wired in Phase C-a/b/c) | Phase D: command palette + preset/compiler registry pull more out |
| [src/ai_chat.js](src/ai_chat.js) | 746 | View shell + factory + image attach (controller logic now in `chat_ctl.js`; bar UI in `prompt_bar/`) | Phase D: presets own system-prompt selection |
| [src/network_viz.js](src/network_viz.js) | 562 | D3 viz; not bad, but mixes data + render | Re-evaluate after Phase D |
| [src/cards.js](src/cards.js) | 337 | Model + DOM events (render moved to `applets/card_view/` in Phase C-b) | Phase D: model-only after class-grouping UI lands |

---

## Refactor roadmap (lockstep with the map)

### Phase A · Foundations (this PR)
- [x] [src/capabilities.js](src/capabilities.js) — the matrix
- [x] [ARCHITECTURE.md](ARCHITECTURE.md) — this file
- [ ] Tiny `src/event_bus.js` (~30 LOC pub/sub) — decoupling for Phase B

**Acceptance**: zero behavior change. Both builds still work. `caps` is
imported from one place but not yet read anywhere.

### Phase B · Controllers (extract from `main_script.js`)
1. ✓ `src/controllers/compile_ctl.js` — smallest, well-bounded, easy first win
2. ✓ `src/controllers/chat_ctl.js` — pull non-UI parts out of `ai_chat.js`
3. ✓ `src/controllers/card_ctl.js` — rehydrate today; draft/freeze/regenerate
   (#17/#18/#19) follow-up will land here
4. ✓ `src/controllers/doc_ctl.js`, `project_ctl.js`
5. `main_script.js` continues to shrink as Phase C applets pick up DOM
   work; today it owns bootstrap, walkthrough orchestration, host bridge,
   panel resizers, mobile tabs, and settings UI.

**Acceptance**: project/doc/card state lives in controllers, not in
`main_script.js`. Controllers are unit-testable without DOM. The original
`< 200 LOC` target moves to Phase C since the remaining concerns in
`main_script.js` are bootstrap/UI shell, not state ownership.

**Event bus contract so far**:
- `compile:requested` { doc, project } → fired by main_script when the
  Compile button or `compile-current` host message arrives.
- `compile:succeeded` { filename, source, destination, warnings, delivery }
  → fired by `compile_ctl` on success. Subscribers: modal display.
- `compile:failed` { error } → fired by `compile_ctl` on failure.
  Subscribers: modal display.
- `chat:send-requested` { userInput, references, codeMode, cardTitle,
  docTitle, attachedImages } → fired by ai_chat's `askAI()` when the user
  hits SEND.
- `chat:started` { codeMode } → fired by `chat_ctl` once the agent is
  resolved and the request is in flight. Subscribers: clear chat surface,
  show "streaming…" placeholder.
- `chat:streaming` { delta, codeMode } → per-token, when supported.
  Subscribers: append to response editor.
- `chat:complete` { text, codeMode, wasStreaming } → final cleaned text.
  Subscribers: replace editor contents (mounting if non-streaming).
- `chat:error` { kind, err, codeMode } → `kind ∈ {no_agent,
  local_unreachable, api_key_missing, rate_limit, other}`. Subscribers:
  show the right modal copy.

### Phase C · Applets (extract from controllers)
1. `src/applets/prompt_bar/` ✓ — prompt + model + lang + send + stop
   (Phase C-a, #45)
2. `src/applets/card_view/` ✓ — header, code, markdown, class
   (Phase C-b, #45). Per-kind files self-register via
   `card_view/registry.js`; adding a new kind is one new file with one
   `register('foo', render)` call.
3. Capability-gated applets ✓ — `feedback_widget/`, `terminal_handoff/`,
   `landing_tour/` (Phase C-c, #46). `mount()` is unconditional; each
   applet checks its own `can('...')` and no-ops on the wrong target.
4. `src/applets/command_palette/` — ⌘K + ? overlay (issue #26)

**Acceptance**: every applet is one folder, has its own README, mounts
through one `mount()` function, declares its capability requirement.

### Phase D · Presets + compiler registry
1. `src/preset_schemas/{markdown,python}.js`
2. `src/compilers/index.js` registry; move `code_compile.js` →
   `compilers/python.js`
3. Bibliography assembly + system prompt selection move to presets
4. Future C#/C++ become 1-file additions

**Acceptance**: adding a language is one preset file + one compiler file
+ one row in `caps.languages`. Zero changes to controllers or applets.

---

## Conventions for AI agents

When you (an AI) are asked to make a change:

1. **Read this file first.** Map your task to a layer.
2. **Search the layer's directory only.** If your task is "add a button to the
   prompt bar", you should be reading `src/applets/prompt_bar/` (or
   `ai_chat.js` until Phase C lands), not the whole codebase.
3. **Capability gates over branches.** New target-specific behavior →
   add a key to `capabilities.js`, gate with `can('foo')`. Don't add a fifth
   `if (isRunningInVsCode())`.
4. **Update the map.** If you add a file, add a row to § Where things live.
   If you add a capability, add a row to § Capability matrix. Drift between
   map and code is a bug.
5. **Keep files under ~400 LOC.** If you're about to push one over, split it
   first.
6. **Tests live next to the thing.** Phase C+: `src/applets/foo/foo.test.js`,
   not a sibling `tests/` directory.

---

## Glossary

- **Applet** — a self-contained interaction (button, panel, dialog) that
  mounts into a DOM root, subscribes to model events, and emits intent
  events. Has no direct knowledge of other applets.
- **Bibliography** — the assembled context (system prompt + header card +
  `@ref` sources + draft chat) sent to the model on each generation.
- **Card kind** — `header | body | class`. Independent of language.
- **Capability** — a binary or structured flag in `capabilities.js` that
  decides whether an applet/feature mounts in the current target.
- **Draft / frozen** — every code card has a working draft (chat +
  candidate source) and a canonical frozen `(prompt, source)` pair.
  Downstream cards only see frozen siblings.
- **Header card** — the pinned, undeletable card at index 0 of every doc;
  holds module-scope setup (imports, constants).
- **Host** — the runtime environment slate is loaded into. Today: web
  browser or VS Code webview.
- **Preset schema** — bundle of `{ language, systemPrompt, cardSchema,
  compiler, bibliographyAssembler, shortcuts, budget }` selected by
  `card.language`.
- **Target** — `'web' | 'vscode'`. Used as a key into the capability
  matrix.
