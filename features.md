---
tags: [project, slate, slate-code, features, v0.2]
status: living
---

# slate-code — shipped features

This file is the **append-only log of resolved issues**. When an issue ships:

1. Cut the issue's full block from [issues.md](issues.md).
2. Paste it under the matching phase heading below.
3. Append a `**Resolved:** YYYY-MM-DD — <commit-sha-or-PR-link>` line at the
   bottom of the block.
4. Add a one-line `**Notes:**` if anything diverged from the original
   acceptance criteria (deferred sub-scope, follow-up issues filed, etc.).

Phase headings are pre-seeded so resolved issues land in the right place
without churn.

---

## Phase 1 · Header card primitive

*(no issues resolved yet)*

---

## Phase 2 · System prompt + 16K budget enforcement

*(no issues resolved yet)*

---

## Phase 3 · Streaming + cancel

*(no issues resolved yet)*

---

## Phase 4 · Code-card schema migration

*(no issues resolved yet)*

---

## Phase 5 · Card hierarchy (class → methods)

*(no issues resolved yet)*

---

## Phase 6 · Cell-as-sandbox loop, manual mode

*(no issues resolved yet)*

---

## Phase 7 · Target/language registry

*(no issues resolved yet)*

---

## Phase 8 · Prompt-bar UI overhaul + shortcuts

*(no issues resolved yet)*

---

## Phase 9 · Tic-tac-toe example + CI

*(no issues resolved yet)*

---

## Phase 10 · Hosting freeze

*(no issues resolved yet)*

---

## Cross-cutting decisions

*(no decisions resolved yet)*

---

## Pre-v0.2 (already shipped, for context)

The v0.1 work from [slate-code-plan.md](slate-code-plan.md) is the baseline
this v0.2 plan builds on. Brief recap of what's already in the codebase as
of v0.2 spec start:

- Local Ollama agent (`LocalAgent` in `src/ai_utils.js`)
- Code card type (`cardType: 'code'`) — to be migrated to `language` (#9)
- Python compile path (`src/code_compile.js`) — to be moved + extended (#11, #21)
- VS Code extension shell (`vscode-extension/`) — to be expanded (#20, #22)
- Doc destination field — to be folded into target system (#21)

These are not re-listed as resolved issues here because they predate the
v0.2 issue numbering.

---

*Related: [issues.md](issues.md) · [slate-code-v0.2-spec.md](slate-code-v0.2-spec.md) ·
[slate-code-plan.md](slate-code-plan.md)*
