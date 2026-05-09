---
tags: [project, slate, slate-code, plan, v0.2, local-llm, multi-language, vscode]
status: draft-unified
supersedes-partially: slate-code-plan.md
---

# slate-code v0.2: spec (unified)

> Builds on [slate-code-plan.md](slate-code-plan.md). v0.1 shipped local Ollama,
> code cards, Python compile, and a VS Code extension shell. v0.2 turns that
> into a proper local-LLM **code harness**: a leaves-up generation loop with
> human-scale function review, multi-language targets, doc headers, code-as-code
> (not opaque JSON), streaming with cancel, a chat-style UI, and one hosting
> story (VS Code).

---

## Philosophy (the load-bearing idea)

Slate is for writing code at the scale of **one function at a time, that a
human can read and verify**, not at the scale of "ask an AI for an app and
hope." The local model (Qwen 2.5-Coder 30B in 16K context) is treated as a
stateless generator; *the user* is the orchestrator. Each function is
generated, run in the VS Code terminal, accepted by the user, then frozen.
Downstream functions see frozen siblings as already-working symbols.

This is the [motivation.md](motivation.md) thesis applied to code: no sliding
window, no hidden state, explicit context per generation, the graph IS the
program.

---

## Goals

1. **Local LLM code harness, leaves-up.** Slate is the place you architect
   code with a local model; VS Code is where it runs. Build leaf functions
   (no `@refs` going out) first, move up the dependency graph; downstream
   cards see frozen siblings as already-working symbols.
2. **Per-doc header card.** Every doc carries a default, pinned card holding
   parent-scope setup (imports, constants, type aliases). It is the first
   thing in the compiled file and the first thing in every code card's
   bibliography.
3. **Card hierarchy for OOP.** Cards can nest: a class-card contains
   method-cards. Required for any OOP language (Python, C++, C#, JS
   classes). One level of nesting in v0.2.
4. **Stateless 16K discipline.** Per-card token budget = system prompt +
   header card + direct `@refs` + this card's own prompt + last 2 turns.
   Nothing else. Estimated and surfaced before send.
5. **Chat-style prompt bar.** Model and language pickers live next to ADD
   TO DOC, not buried in settings. Streaming with `⌘.` to cancel.
6. **Code is code, not JSON.** A code card's payload is `{ language,
   prompt, source, tests, metadata }`. The compiled file embeds the prompt
   as a `# @slate:` comment so reviewers see intent next to code.
7. **One harness, two surfaces.** Slate is one product (LLM harness with
   explicit context). The web build (GH Pages) ships the full harness
   including code cards + compile-to-download; the VS Code extension adds
   terminal hand-off, workspace fs writes, and the `.slate.json` custom
   editor on top. Same JS bundle, host detection at runtime via
   `host_bridge.js#isCodeHost()`. See §3.

## Non-goals (v0.2)

- C++/C#/JS compilers — architecture supports them, only Python ships.
- **Executing code inside slate.** Slate sends snippets to the VS Code
  terminal via the extension; the user runs them. No Pyodide, no
  subprocess, no in-slate REPL. Fancy "test across input range with graphs"
  is future work.
- Importing arbitrary `.py` files. Round-trip is via `.slate-map.json`
  index + `# @slate:` annotations only on files slate emitted itself.
- Auto-iterate loop (model self-corrects on test failure). v0.2 is
  human-in-the-loop only: generate → user runs in terminal → user accepts
  or hits regenerate → freeze.
- Mixed-language docs. One doc, one language.

## In-scope changes from v0.1

- Streaming responses + `⌘.` cancel (was non-goal in v0.1, in for v0.2).
- VS Code extension is the canonical code-mode surface (browser hides
  code UI).
- Header cards, card nesting, leaves-up generation loop, terminal
  hand-off, tic-tac-toe example as CI gate.

---

## 1 · Multi-language target system

### Data model

Replace per-doc `destination` string with a project-level target descriptor.

```js
// Project gains:
project.targets = [
  {
    id: 'py-default',
    language: 'python',
    sourceRoot: 'src/python',         // workspace-relative
    fileExt: '.py',
    importStrategy: 'absolute',       // or 'relative'
  },
  // future: 'cpp-default', 'cs-default', 'js-default'
];

// Doc gains:
doc.targetId = 'py-default';
doc.destination = 'lib/util';         // sub-path under target.sourceRoot

// Card replaces cardType with language:
card.language = 'markdown' | 'python' | 'cpp' | 'csharp' | 'javascript';
// 'markdown' = prose card; everything else = code card.
```

### Compile registry

```js
// src/compilers/index.js
export const compilers = {
  python: pythonCompiler,
  // cpp:    cppCompiler,    // stub: throws "not implemented in v0.2"
  // csharp: csharpCompiler, // stub
  // js:     jsCompiler,     // stub
};
```

`code_compile.js` becomes `src/compilers/python.js`. The dispatcher lives
in `src/compile.js` and routes by `target.language`.

### Source ↔ target mapping

Output path = `<workspaceRoot>/<target.sourceRoot>/<doc.destination>/<doc.title><target.fileExt>`.

Sidecar index `<target.sourceRoot>/.slate-map.json`:

```json
{
  "version": 1,
  "entries": {
    "lib/util/helpers.py": {
      "docId": "...", "projectId": "...",
      "compiledAt": "...", "cardIds": ["...", "..."],
      "sourceHash": "sha256:..."
    }
  }
}
```

`sourceHash` enables drift detection (file edited outside slate → next
compile prompts user before overwrite). v0.2 writes the index; v0.3 reads
it for drift checks.

### Migration

- Old projects with no `targets[]`: synthesize one default Python target on
  load, set every doc's `targetId` to it, copy `doc.destination` through.
- `card.cardType: 'code'` → `card.language: 'python'`.
- `card.cardType: 'markdown'` → `card.language: 'markdown'`.

---

## 2 · Doc header card

Every doc has exactly one header card, auto-created at `Doc.init()`,
pinned at position 0, undeletable.

```js
// cards.js
export const CARD_KIND_HEADER = 'header';
export const CARD_KIND_BODY = 'body';
export const CARD_KIND_CLASS = 'class';   // see §2.5

class Card {
  // ...existing fields...
  this.kind = CARD_KIND_BODY;             // 'header' | 'body' | 'class'
  this.parentCardId = null;               // for nesting (see §2.5)
}
```

### Behavior

- **Compile order**: header card → body code cards in topological order
  (leaves first; see §6).
- **Bibliography injection**: when generating any code card, the header
  card's source is included at the top of the system context as
  *"This file already has the following at module scope; use these
  symbols rather than re-importing or redeclaring them."*
- **UI**: rendered above the doc title with a different border (monad
  accent), a "header" pill badge, no `[× remove]` no `[↗ move]`.
  Title fixed to `__header__`.
- **Generation**: hand-written by default. One-click helper "Extract
  imports from existing cards" scans body card top-level imports and writes
  them into the header (idempotent).
- **Round-trip**: header is a Card with `kind: 'header'`. Old projects
  load and synthesize an empty header card on first save.

### Tradeoff

Header is implicit context referenced by every other card in the doc.
Mitigated by always rendering it as the first item in the bibliography
**preview** before SEND, so the user sees exactly what's going out.

---

## 2.5 · Card hierarchy: class → methods

Required for OOP languages (Python classes, C++ classes, C# classes,
JS classes). One level of nesting in v0.2.

```js
// A class card holds the class body's signature + any class-level state;
// its method cards are body cards with parentCardId = classCard.id.
classCard = {
  kind: 'class',
  language: 'python',
  title: 'BoardState',
  source: 'class BoardState:\n    """3x3 game board."""\n    pass',
  // methods are separate cards referencing this one as parent
}

methodCard = {
  kind: 'body',
  language: 'python',
  parentCardId: classCard.id,
  title: 'is_winning_line',
  source: 'def is_winning_line(self, line):\n    return ...'
}
```

### UI

Class cards render with their methods indented under them in the doc view
(visual nesting, like Jupyter cell groups). Click the class card to fold /
unfold its methods.

### Compile

The Python compiler:
1. Emits the class card's source verbatim (e.g. `class BoardState:` and
   any class-level attrs).
2. For each method card with `parentCardId === classCard.id`, indents the
   method source one level and emits it inside the class block.
3. If the class card body is just `pass`, it's stripped.

### Cross-language note

C++ / C# / JS compilers will need the same nesting model. The data
structure is language-agnostic; only the indentation/braces logic differs
per compiler. v0.2 only implements Python.

---

## 3 · Hosting: one harness, two surfaces

**Slate is one product — an LLM harness with explicit context control —
delivered as two surfaces with different powers. Same source, same JS
bundle, no build split.** *(Updated 2026-05-09 — earlier framing called
this "two products"; that was wrong. See §3 changelog at the bottom.)*

| Surface | Delivery | What ships |
|---|---|---|
| **Web** | GitHub Pages, auto-deployed from `main` via `.github/workflows/pages.yml` | Full LLM harness: cards, @refs, header cards, code cards, language picker, model picker, streaming, distill+freeze, dep graph, token budget, system prompts, **compile-to-download** (browser save-as for the `.py`) |
| **VS Code extension** | Sideload (VSIX) → marketplace later | Everything web has, **plus** terminal hand-off (`⌘⇧R`), compile-to-workspace (write `.py` directly), `.slate.json` custom editor, `.slate-map.json` drift index |

The host-specific slice is small: terminal access, workspace fs writes,
custom editor registration. Everything else (the entire LLM harness) is
shared code that runs in both surfaces.

### Why not Electron

- VS Code already provides: file system, workspace conventions, terminal,
  debugger, git, settings sync, marketplace install. Electron means
  re-implementing all of it.
- Code mode's juiciest workflow ("compile next to your workspace, run
  snippets in the workspace terminal") *is* a VS Code workflow.

### What changes

- `host_bridge.js` already detects host. `isCodeHost()` returns true only
  inside VS Code. It gates **only** the host-specific bits (terminal
  hand-off button, "compile to workspace" path, `.slate-map.json` write,
  `.slate.json` custom editor registration). It does **not** gate the
  language/model dropdowns, code cards, draft/freeze, dep graph, token
  budget, system prompts, or compile itself — those all run on the web.
- Web compile path: the existing `host_bridge.js` already does the
  `URL.createObjectURL` + synthesized `<a download>` flow when not in VS
  Code. No new work.
- **`slate-notebook.com` is retired.** Web build serves from
  `https://<user>.github.io/slate/` (or a custom domain via a `CNAME`
  file in `dist/` if we add one later). Vite's `base` is set via the
  `BASE_URL` env in the workflow.
- **`dist/` stays untracked.** GH Actions builds it on push; we don't
  ship build artifacts in git.

### §3 changelog

- *2026-05-09 (this revision)*: Reframed from "two products, gated by
  host" to "one harness, two surfaces; gate only host-specific bits."
  Web is no longer "markdown notebook only" — it gets the full LLM
  harness including code cards and compile-to-download. Domain retired
  in favor of GH Pages. `dist/` stays untracked.

---

## 4 · Prompt bar: chat-style layout

### Today

```
[ prompt textarea ......................................... ]
[ATTACH IMAGE] [Code] [SEND]  [ADD TO DOC]
```

### v0.2

```
┌──────────────────────────────────────────────────────────┐
│ prompt textarea                                          │
│   (streaming response renders inline once SEND fires)    │
└──────────────────────────────────────────────────────────┘
[+img] [lang: python ▾] [model: qwen2.5-coder:30b ▾]   [↵ ADD TO DOC]
                                                       [■ STOP] (while streaming)
```

- **Language dropdown** replaces the boolean "Code" toggle. Selecting
  non-markdown auto-routes to the local provider.
- **Model dropdown** filtered by language pick:
  - `markdown` → cloud agents the user has keys for
  - any code language → local Ollama models + cloud agents marked
    "code-capable"
- **ADD TO DOC** is the single primary action. The streaming response
  renders inline in the prompt area; ADD TO DOC commits it to a card.
- **STOP** appears during streaming; cancels the request and discards the
  partial. Local models are slow; you need to see a derail early.
- Settings modal still holds API keys / base URLs / model lists, but is
  no longer where you switch model per-prompt.

### 4.1 · Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘↵` | Send / commit current card |
| `⌘.` | Stop streaming |
| `Esc` | Close any modal, cancel autocomplete, abort stream |
| `⌘K` | Command palette: compile, switch model, switch language, run-card-in-terminal, freeze, regenerate |
| `⌘E` | Extract imports from doc → header card |
| `⌘⇧R` | Send current card's source to VS Code terminal (with header + imports prelude) |
| `⌘⇧F` | Freeze current card (lock source, mark accepted) |
| `⌘G` | Regenerate current card with same prompt + bibliography |
| `⌘D` | Distill draft chat → single canonical prompt (review step before freeze) |
| `@` | Reference autocomplete (already exists) |

---

## 5 · Code as code (not opaque JSON)

### Persisted shape

```js
// markdown card (unchanged)
{
  id, title, prompt, images, links,
  language: 'markdown',
  kind: 'body',
  content: '<rendered html>'
}

// code card — pre-freeze (working state)
{
  id, title, images, links,
  language: 'python',
  kind: 'body' | 'header' | 'class',
  parentCardId: null,                      // see §2.5
  prompt: '<initial NL prompt>',           // canonical (will be distilled)
  source: null,                            // not yet committed
  draft: {                                  // see §6.5
    chat: [
      { role: 'user',      content: '...', tokens: 12 },
      { role: 'assistant', content: '...', tokens: 80 }
    ],                                     // last 3 turns max (rolling window)
    candidateSource: 'def foo(x): ...',    // latest assistant code
    iterationCount: 2
  },
  tests: [                                  // see §7
    { kind: 'snippet', code: "assert foo(1) == 2" },
    { kind: 'io', input: '1', expected: '2' }
  ],
  frozen: false,
  metadata: {
    model: 'qwen2.5-coder:30b',
    provider: 'local',
    generatedAt: '...',
    tokensUsed: 1234
  }
}

// code card — post-freeze (canonical pair)
{
  id, title, images, links,
  language: 'python',
  kind: 'body' | 'header' | 'class',
  parentCardId: null,
  prompt: '<distilled NL intent — single paragraph>',
  source: 'def foo(x):\n    return x + 1\n',
  draft: null,                              // cleared on freeze
  tests: [...],
  frozen: true,
  metadata: {
    model: 'qwen2.5-coder:30b',
    provider: 'local',
    generatedAt: '...',
    tokensUsed: 1234,
    iterations: 2,
    distilledBy: 'manual' | 'auto'         // see §6.5
  }
}
```

`content` disappears from code cards; `source` is authoritative.
Migration: existing code cards run `getPythonSource()` once on load and
store the result as `source`; old `content` is dropped.

### Compiled artifact carries the prompt

```python
# Compiled from slate doc: data_pipeline
# Generated by slate-code; do not edit by hand.

import numpy as np
import pandas as pd

# @slate: card=load_csv doc=data_pipeline frozen=true
# @slate-meta: model=qwen2.5-coder:30b generated_at=2026-05-09T12:34:56Z iterations=2
# @slate-prompt: |
#   Read a CSV from `path`, return a pandas DataFrame.
#   Skip blank lines and treat 'NA' as missing.
def load_csv(path):
    return pd.read_csv(path, skip_blank_lines=True, na_values=['NA'])
```

### Why

- The prompt is a docstring-grade record of intent next to the code.
  Code review of slate-generated files is dramatically easier.
- The compiled file is a self-describing serialization (future v0.3 can
  re-import via `# @slate:` markers).
- Local-model regen ("rewrite with the same prompt against a newer
  model") is trivial: read `# @slate-prompt:`, re-run.

### Risks

- Models may emit `# @slate*` lines themselves. Compiler reserves the
  namespace; collisions are escaped to `# (was-@slate)` before emit.
- Long prompts: use literal-block style (`|`) with `# ` line prefix.

---

## 6 · Cell-as-sandbox loop (the workflow)

This is the centerpiece. v0.2 ships **manual mode**: human runs the test,
human freezes the card. v0.3 may add auto-iterate.

### The loop, per card, in topological order (leaves first)

```diagram
╭─────────────────────╮
│ pick next card      │  ← lowest in dep graph that isn't frozen
│ (graph: leaves up)  │
╰──────────┬──────────╯
           ▼
╭─────────────────────╮
│ compose context     │  system prompt + header card + direct @refs
│ (≤ 16K tokens)      │  + this card's prompt + last 2 turns
╰──────────┬──────────╯
           ▼
╭─────────────────────╮
│ stream generation   │  ⌘. to abort if it goes wrong early
│ (local Ollama)      │  → appended to draft.chat (rolling 3 turns)
╰──────────┬──────────╯
           ▼
╭─────────────────────╮
│ user runs ⌘⇧R       │  send "header imports + frozen @refs + draft
│ in VS Code terminal │   candidate src + tests" as paste-block
╰──────────┬──────────╯
           ▼
       ┌───┴───┐
       ▼       ▼
   ╭─────╮ ╭───────────────────────╮
   │pass │ │ fail / not quite right│
   ╰──┬──╯ ╰─────┬─────────────────╯
      │          │
      │          ▼
      │      ╭────────────────────╮
      │      │ refine in chat,    │
      │      │ or ⌘G regenerate   │
      │      │ (cap: 3 attempts;  │
      │      │  user can extend   │
      │      │  by 5; then human  │
      │      │  writes the func)  │
      │      ╰─────┬──────────────╯
      │            │
      │            ▼  loops back to stream generation
      ▼
╭─────────────────────╮
│ ⌘D distill          │  collapse draft.chat → one canonical prompt
│ (manual or auto)    │  user reviews / edits before commit
╰──────────┬──────────╯
           ▼
╭─────────────────────╮
│ ⌘⇧F freeze          │  source := draft.candidateSource
│                     │  prompt := distilled prompt
│                     │  draft  := null; frozen := true
╰──────────┬──────────╯
           ▼
        next card
```

### Iteration policy

- **Default cap: 3 regenerations** before slate suggests the user write
  the function by hand.
- User can hit "+5 more" to extend the cap if they want to keep trying.
- *Philosophy*: if the human can figure out the function before the model
  can, the human writes it. We're working at function-scale precisely so
  human-writing is feasible and verifiable.

### Terminal hand-off

`⌘⇧R` sends a paste-block to VS Code's integrated terminal:

```python
# ===== slate: testing card 'is_winning_line' from doc 'tic_tac_toe' =====
# imports & header
import numpy as np
# frozen @refs
def board_state(): ...   # frozen
# the candidate function
def is_winning_line(line):
    return all(c == line[0] and c != ' ' for c in line)

# tests
assert is_winning_line(['X','X','X']) is True
assert is_winning_line(['X','O','X']) is False
print("OK")
```

Implemented in `vscode-extension/src/extension.ts` via
`vscode.window.activeTerminal.sendText()`. No subprocess; the user owns
the Python interpreter the terminal is running.

### Freezing

A frozen card:
- Locks `source` (UI shows it read-only; un-freeze button reverts to
  editable + drops `frozen: true`)
- Is treated as "known good" by downstream cards (its source goes into
  their bibliography as a finished symbol, not a draft)
- Compiles with `# @slate: ... frozen=true`

### Markdown cards in the loop

The loop applies to code cards. Markdown cards are still freely
generated, no test/freeze step — the markdown notebook flow is preserved
1:1 inside the same doc. A doc can mix prose cards (design notes) and
code cards (functions); only code cards participate in topological
compile.

### Token budget enforcement

Pre-send token estimator (rough char-count / 3.5 heuristic for now). If
the assembled context exceeds the model's window minus generation
headroom (default 16K - 2K = 14K input budget):
- Surface a warning with what's blowing the budget (usually a too-large
  `@ref`)
- Suggest dropping refs or splitting the card
- Refuse to send if user doesn't shrink

This is the philosophical kernel: stateless model, finite window, no
hidden context. Same as [motivation.md](motivation.md), applied to code.

---

## 6.5 · Per-card chat draft and the distill-then-freeze ceremony

The §6 loop names "draft" and "distill" without defining them. This section
does. The model: **a card has two states (working draft + canonical frozen
pair); going from draft to frozen is an explicit ceremony.**

### Why two states

A pure "one prompt, one source" model is rigid (you have to rewrite the
same prompt over and over). A pure "open-ended chat per card" model loses
the slate philosophy (chat history becomes hidden state, the compiled
file fills with messy back-and-forth). The layered model gets both: a
shallow chat while you're working, collapsed to one canonical
`(prompt, source)` pair the moment you commit.

### Working state (draft)

While iterating on a card, slate keeps a `draft` object on the card:

```js
draft = {
  chat: [
    { role: 'user',      content: '...', tokens: 12 },
    { role: 'assistant', content: '...', tokens: 80 },
    // ... rolling window, capped at last 3 turns (6 messages)
  ],
  candidateSource: 'def foo(x): ...',   // latest assistant code block
  iterationCount: 2                     // counts toward the 3-attempt cap
}
```

Generation context per send (token-budget rules from §6 still apply):
- system prompt (§8)
- header card source
- frozen `@ref` sources (siblings already accepted)
- `draft.chat` (last 3 turns)
- the new user message

The draft is **ephemeral**. It exists in memory + JSON between sessions,
but is wiped on freeze. The chat is never part of the compiled file or
downstream cards' bibliography.

### Distill (the crux)

Going from draft → frozen requires collapsing `draft.chat` into a single
canonical `prompt`. Two paths, both surfaced in the same UI:

- **(a) Manual** *(default)*. User edits `prompt` themselves, with the
  chat shown side-by-side as reference. Honest, no extra model call,
  matches slate's "no hidden state" thesis. Set
  `metadata.distilledBy = 'manual'`.
- **(b) Auto-distill** *(one click, ⌘D)*. AI rewrites the original prompt
  to capture what the user actually meant, given the chat. Convenient but
  introduces a model call that can lie. The user **always reviews** the
  distilled prompt and can edit it before freeze. Set
  `metadata.distilledBy = 'auto'`.

Either way, the user sees and approves the distilled prompt before
freeze commits.

### Freeze ceremony

`⌘⇧F` triggers, in order:

1. If `draft.candidateSource` is empty → reject (nothing to freeze).
2. If `prompt` is still the literal first draft message AND
   `draft.iterationCount > 0` → prompt the user to distill first
   ("the chat went somewhere different from your initial prompt; revise
   it before freezing"). User can override.
3. Commit:
   - `card.source := card.draft.candidateSource`
   - `card.prompt := <distilled prompt>` (already approved in §6.5/distill)
   - `card.metadata.iterations := card.draft.iterationCount`
   - `card.draft := null`
   - `card.frozen := true`
4. Re-render the card in canonical view (read-only source, prompt as
   single-paragraph header).

### Unfreezing

Hitting "edit" / "regenerate" on a frozen card sets `frozen := false`,
re-creates `draft` with `chat: []` and
`candidateSource: <previous source>`, leaves `prompt` as the previous
distilled prompt (which seeds the next iteration). The user can then
chat-iterate again and re-freeze.

### What downstream cards see

Always the **canonical state**:
- A frozen sibling: `(prompt, source)` pair → its source goes into the
  bibliography as a finished symbol.
- An unfrozen sibling (still in draft): treated as **not available**.
  The dep-graph walker (`src/dep_graph.js`) only marks a card "ready to
  generate" when all its upstream `@refs` are frozen. This enforces the
  leaves-up discipline from §6.

### Risks

- **Users skip the distill step** and the prompt drifts away from the
  source over time. Mitigation: the freeze guard (step 2 above) and a
  visible "prompt out of sync with source" indicator on cards where the
  prompt obviously doesn't describe the source (heuristic: prompt unchanged
  since the first draft message but iterationCount > 0).
- **Auto-distill introduces a hidden model call** that can rewrite the
  user's intent in ways they don't notice. Mitigation: always show the
  diff between the original first prompt and the auto-distilled version;
  require explicit user confirmation, never silent commit.
- **Chat token budget creep** when local models reply with long
  assistant turns. Mitigation: `draft.chat` is capped at 3 turns by
  message *count*, not token count — so the cap is predictable, but
  individual messages can still blow the budget. The pre-send estimator
  (§6) catches this and refuses to send.

---

## 7 · Examples + tests (tic-tac-toe as the CI gate)

### Example project: tic-tac-toe

Ship `examples/tic_tac_toe.slate.json` with a single doc containing:

| Card | Kind | Depends on |
|---|---|---|
| `__header__` | header | — |
| `BoardState` | class | — |
| `BoardState.__init__` | body (method) | `BoardState` |
| `BoardState.render` | body (method) | `BoardState` |
| `is_winning_line` | body | — |
| `check_winner` | body | `is_winning_line`, `BoardState` |
| `valid_moves` | body | `BoardState` |
| `apply_move` | body | `BoardState` |
| `ai_player_random` | body | `valid_moves` |
| `play_loop` | body | everything else |

Each card has 1-3 unit tests in its `tests` field. The doc compiles to
`tic_tac_toe.py`; running `python tic_tac_toe.py` plays a self-game.

### CI

Slate repo gets a CI step that:
1. `npm run build`
2. `node scripts/compile-example.js examples/tic_tac_toe.slate.json
   --out /tmp/tic_tac_toe.py`
3. `python -m pytest /tmp/tic_tac_toe.py` (unit tests)
4. `python /tmp/tic_tac_toe.py` (smoke run, expect non-zero score
   distribution after N games)

This catches regressions in the compiler and the schema. The cards'
`source` in the example JSON is hand-written / accepted output (not
re-generated each CI run — we're testing the harness, not the LLM).

### In-app slate unit tests

Separate from the example: vanilla JS unit tests for the compiler,
migrations, and dependency-graph topo-sort. Whatever JS test framework is
lightest. (Currently slate has none — adding a minimal `vitest` setup
under `tests/`.)

---

## 8 · System prompt for naked Ollama

Local models without a strong system prompt drift hard. Slate ships
`src/compilers/prompts/python.system.txt` (and equivalents per language)
with hard rules:

```
You are a code-generation backend. You receive:
  - A header context (already at module scope; do not re-import or re-declare)
  - Zero or more @reference symbols (already defined; use them as-is)
  - One natural-language prompt for the function/class/method you must produce

Output ONE Python definition. Rules:
  - No prose, no commentary, no markdown fences
  - Use only symbols listed in the header context and @refs
  - If you cannot generate the requested code, output exactly:
    # SLATE_CANNOT_GENERATE: <one-line reason>
  - End with a single trailing newline
```

Defensive parsing in the client: if the response has fences, strip them;
if it has prose before/after the def, regex-extract the def block; if it
contains `SLATE_CANNOT_GENERATE`, surface as an error (not a card).

---

## Sequencing

Each phase shippable on its own. Order matters: budget enforcement before
streaming, terminal hand-off before the loop UI.

1. **Header card primitive.** `kind` field, auto-create on `Doc.init()`,
   UI rendering, prepend in compile, include in bibliography. Migration
   shim for old projects.
2. **System prompt + 16K budget enforcement.** `python.system.txt`,
   token estimator, pre-send warning + refuse-on-overflow.
3. **Streaming + cancel.** Token-by-token render in the prompt area,
   `⌘.` / STOP button to abort.
4. **Code-card schema migration.** `source` + `tests` + `frozen` +
   `metadata`. Compiler emits `# @slate:` annotations.
5. **Card hierarchy (class → methods).** `kind: 'class'`, `parentCardId`,
   indented UI rendering, compiler nests methods under classes.
6. **Cell-as-sandbox loop, manual mode.** Topological dep-graph walker
   ("next leaf to generate" hint), `⌘⇧R` terminal hand-off via
   `vscode-extension`, `⌘⇧F` freeze, `⌘G` regenerate with iteration cap
   (3 + extend).
7. **Target/language registry.** `project.targets[]`, `doc.targetId`,
   `cardType`→`language`. Python only working; cpp/cs/js stubs.
8. **Prompt-bar UI overhaul + keyboard shortcuts.** Language dropdown,
   model dropdown, single ADD TO DOC, all `⌘`-shortcuts wired.
9. **Tic-tac-toe example + CI.** Ship `examples/tic_tac_toe.slate.json`,
   `scripts/compile-example.js`, CI step, `vitest` unit tests for
   compiler/migrations.
10. **Hosting freeze.** `isCodeHost()` gates code-mode UI in browser.
    README + landing copy update.

(Deferred to v0.3: auto-iterate loop, `.slate-map.json` drift detection,
additional language compilers, function-range graphing in terminal,
`.py`→slate import, mixed-language docs.)

---

## Critical files

Existing:
- `src/cards.js` — add `kind`, `parentCardId`, `frozen`, `tests`,
  replace `cardType` with `language`, drop `content` for code cards.
- `src/doc.js` — auto-create header card; remove `destination` (move to
  doc-level under target).
- `src/project.js` — `targets[]` array; migration on load.
- `src/code_compile.js` — move to `src/compilers/python.js`; emit
  `# @slate:` annotations; prepend header card; nest methods under classes.
- `src/main_script.js` — prompt-bar refactor; language/model dropdowns;
  shortcut wiring.
- `src/ai_chat.js` — bibliography includes header card + frozen `@refs`;
  system prompt branches on `language`; streaming render; token budget
  estimator + warning.
- `src/host_bridge.js` — `isCodeHost()` helper.
- `vscode-extension/src/extension.ts` — `slate.runInTerminal` command;
  `slate.compileCurrentDoc`; language-aware compile dispatch.

New:
- `src/compile.js` — generic dispatcher.
- `src/compilers/index.js` — registry.
- `src/compilers/python.js` — moved + extended (class nesting, prompt
  annotations).
- `src/compilers/prompts/python.system.txt` — system prompt for codegen.
- `src/migrations.js` — JSON migration shims.
- `src/header_card.js` — header card factory + bibliography helpers.
- `src/dep_graph.js` — topological sort over @refs; "next leaf" finder.
- `src/token_budget.js` — char-count heuristic, per-model window config.
- `src/terminal_handoff.js` — assemble paste-block (header + frozen refs
  + candidate src + tests) and ship to VS Code via host bridge.
- `examples/tic_tac_toe.slate.json` — CI gate.
- `scripts/compile-example.js` — CI helper.
- `tests/` — `vitest` setup; compiler / migrations / dep-graph tests.

---

## Open questions remaining

1. **Class nesting depth**: one level only in v0.2 (class → methods).
   Nested classes / inner functions: v0.3?
2. **Test format**: `{kind: 'snippet'}` (raw assert lines) or
   `{kind: 'io', input, expected}` (data-driven)? Spec lists both — do we
   ship both, or pick one for v0.2?
3. **Token budget heuristic**: char/3.5 is wildly imprecise for code.
   Worth pulling in `js-tiktoken` (~50KB)?
4. **VS Code extension publish**: marketplace from day one, or VSIX
   sideload only until tic-tac-toe CI is green?

---

*Related: [slate-code-plan.md](slate-code-plan.md) (v0.1 spec) ·
[motivation.md](motivation.md) · [README.md](README.md)*

---

## Changelog from v0.2 draft → unified

- **§ Philosophy** added: the load-bearing "human-scale function review"
  framing.
- **Goal 1 reworded**: explicit leaves-up direction.
- **Goal 3 added**: card hierarchy (class → methods) for OOP.
- **Goal 4 added**: stateless 16K discipline as a top-level goal.
- **Goal 7 added**: markdown notebook stays first-class as the browser
  product (with strict-schema markdown).
- **Non-goal**: in-slate execution stays out *forever*, not just v0.2.
  Terminal hand-off via VS Code is the model.
- **In-scope**: streaming + `⌘.` cancel moved from non-goal → in-scope
  for v0.2.
- **§2.5 Card hierarchy** added: class cards with method children, one
  level deep, language-agnostic data model, Python-only compile in v0.2.
- **§4.1 Keyboard shortcuts** added.
- **§5 schema** gained `tests`, `frozen`, `parentCardId`, `iterations`.
- **§6 Cell-as-sandbox loop** added — the centerpiece. Leaves-up,
  3+5 iteration cap, terminal hand-off via VS Code, freeze/regenerate
  flow. Markdown cards explicitly carved out of the loop.
- **§6.5 Per-card chat draft + distill-then-freeze ceremony** added.
  A card has two states: a working `draft` (rolling 3-turn chat +
  candidate source) and a canonical frozen `(prompt, source)` pair.
  Going from draft → frozen requires distilling the chat into one
  prompt (manual default, `⌘D` for AI auto-distill). Downstream cards
  only see frozen siblings.
- **§7 Examples + tests** added: tic-tac-toe as CI gate, doc structure,
  in-app vitest setup.
- **§8 System prompt for naked Ollama** added.
- **Sequencing rewritten** — 5 phases → 10 phases, ordered by dependency
  (budget before streaming, terminal hand-off before loop).
- **Critical files** updated to reflect new modules: `dep_graph.js`,
  `token_budget.js`, `terminal_handoff.js`, `compilers/prompts/`.
