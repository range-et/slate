/**
 * Headless audit + compile tests for the calculator example.
 *
 * Why this file exists:
 *   The user kept hitting the same bug — operations.py compiling with
 *   `OPS["+"] = add` (and friends) at module top, before `add` was
 *   defined, causing a NameError at import time. Manually editing the
 *   header card to comment those lines out felt like whack-a-mole
 *   because the failure mode could come from many places: stale JSON in
 *   the working tree, a stale cached compile artifact, the model
 *   regenerating bad header-additions despite the system prompt, etc.
 *
 *   Browser interaction is not the bug surface here — info retrieval,
 *   audit, and compile are pure functions over JSON. So we test them
 *   pure: load the .slate.json from disk, run the same compile + audit
 *   path the live app uses, assert structural invariants. Any future
 *   regression that produces forward-ref module-scope statements at
 *   the top of a compiled file fails this suite immediately.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Project from '../src/project.js';
import { compileDocToPython } from '../src/code_compile.js';
import {
    buildBibliography,
    splitFunctionAndHeaderAdditions,
    applyHeaderAdditions,
    isSafeHeaderAdditionLine,
} from '../src/controllers/chat_ctl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALC_DIR = join(HERE, '..', 'examples', 'calculator');

function loadProject(filename) {
    const raw = readFileSync(join(CALC_DIR, filename), 'utf8');
    return Project.fromJSON(JSON.parse(raw));
}

/* ────────────────────────────── shape ─────────────────────────────── */

describe('calculator sample · structure', () => {
    it('loads calculator.slate.json into a 2-doc project', () => {
        const p = loadProject('calculator.slate.json');
        expect(p.getDocCount()).toBe(2);
        const titles = p.getAllDocs().map(d => d.title).sort();
        expect(titles).toEqual(['calculator', 'operations']);
    });

    it('loads calculator.prompts_only.slate.json with the same shape', () => {
        const p = loadProject('calculator.prompts_only.slate.json');
        expect(p.getDocCount()).toBe(2);
    });

    it('every doc has a __header__ card pinned at index 0', () => {
        for (const file of ['calculator.slate.json', 'calculator.prompts_only.slate.json']) {
            const p = loadProject(file);
            for (const doc of p.getAllDocs()) {
                expect(doc.cards[0].isHeader()).toBe(true);
                expect(doc.cards[0].title).toBe('__header__');
            }
        }
    });
});

/* ─────────────────────────────── audit ─────────────────────────────── */

/**
 * Reusable audit helper. Returns an array of finding objects so callers
 * can assert on count, kind, and offending content. Each finding is
 * `{ kind, doc, card?, detail }`.
 *
 * Findings:
 *   - 'header-forward-ref': a header card has a top-level statement
 *     that calls or references a name that's defined later in the same
 *     module (i.e. by a body card). The classic OPS["+"] = add bug.
 *   - 'broken-ref': an @-reference in a card prompt points to a card
 *     title that doesn't exist anywhere in the project.
 *   - 'unresolved-card': non-header card has a non-empty prompt but no
 *     content yet (= eligible for GENERATE ALL; not necessarily an
 *     error, but useful for project-wide reporting).
 */
function auditProject(project) {
    const findings = [];

    // Index every card title in the project so we can resolve @refs.
    const knownTitles = new Set();
    for (const doc of project.getAllDocs()) {
        for (const card of doc.getAllCards()) knownTitles.add(card.title);
    }

    for (const doc of project.getAllDocs()) {
        // Per-doc list of body symbol names — anything assigned at the
        // top level of a body card. We use this to flag header lines
        // that reference symbols defined later.
        const bodySymbols = new Set();
        for (const card of doc.getAllCards()) {
            if (card.isHeader()) continue;
            // Match `def name(...)`, `class name(...)`, `name =`, `name:`
            const src = (card.content || '');
            const defRe = /^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
            let m;
            while ((m = defRe.exec(src)) !== null) bodySymbols.add(m[1]);
            const assignRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/gm;
            while ((m = assignRe.exec(src)) !== null) bodySymbols.add(m[1]);
        }

        // Header forward-reference scan. We look for module-scope
        // statements (top-level lines not inside a docstring or
        // function) whose RHS or arg list references a body symbol.
        const header = doc.getAllCards().find(c => c.isHeader && c.isHeader());
        if (header) {
            const headerLines = stripModuleDocstring(header.content || '').split('\n');
            for (let i = 0; i < headerLines.length; i++) {
                const line = headerLines[i];
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed.startsWith('#')) continue;       // comment
                if (trimmed.startsWith('from ')) continue;   // import
                if (trimmed.startsWith('import ')) continue; // import
                // Check every word; if any matches a known body symbol
                // AND it's not on the LHS of an assignment in the
                // header itself (which would shadow, not reference),
                // flag it.
                const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
                let w;
                while ((w = wordRe.exec(trimmed)) !== null) {
                    const name = w[0];
                    if (!bodySymbols.has(name)) continue;
                    // Skip header LHS assignments — they're declaring,
                    // not referencing. Only the RHS half of `X = Y`
                    // matters for forward-ref.
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx >= 0 && trimmed.slice(0, eqIdx).includes(name)) {
                        const rhs = trimmed.slice(eqIdx + 1);
                        if (!new RegExp(`\\b${name}\\b`).test(rhs)) continue;
                    }
                    findings.push({
                        kind: 'header-forward-ref',
                        doc: doc.title,
                        detail: `header line "${trimmed}" references body symbol "${name}" defined later in ${doc.title}.py`,
                    });
                    break; // one finding per line is enough
                }
            }
        }

        // @-ref + unresolved scan.
        for (const card of doc.getAllCards()) {
            if (card.prompt) {
                const refRe = /@([A-Za-z_][A-Za-z0-9_]*)/g;
                let m;
                while ((m = refRe.exec(card.prompt)) !== null) {
                    const ref = m[1];
                    if (!knownTitles.has(ref)) {
                        findings.push({
                            kind: 'broken-ref',
                            doc: doc.title,
                            card: card.title,
                            detail: `prompt references @${ref} but no card by that title exists in the project`,
                        });
                    }
                }
            }
            if (!card.isHeader() && card.prompt && (card.prompt.trim().length > 0)
                && (!card.content || !card.content.trim().length)) {
                findings.push({
                    kind: 'unresolved-card',
                    doc: doc.title,
                    card: card.title,
                    detail: `card "${card.title}" has a prompt but no content (would be picked up by GENERATE ALL)`,
                });
            }
        }
    }

    return findings;
}

/** Strip a single leading triple-quoted block from a python source
 * string so the audit can scan the actual code lines. */
function stripModuleDocstring(src) {
    const m = src.match(/^\s*("""[\s\S]*?"""|'''[\s\S]*?''')\s*/);
    return m ? src.slice(m[0].length) : src;
}

describe('calculator sample · audit', () => {
    it('the canonical calculator.slate.json has zero header forward-refs', () => {
        const findings = auditProject(loadProject('calculator.slate.json'))
            .filter(f => f.kind === 'header-forward-ref');
        expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    });

    it('the canonical calculator.slate.json has zero broken @-refs', () => {
        const findings = auditProject(loadProject('calculator.slate.json'))
            .filter(f => f.kind === 'broken-ref');
        expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    });

    it('the canonical calculator.slate.json has zero unresolved cards', () => {
        const findings = auditProject(loadProject('calculator.slate.json'))
            .filter(f => f.kind === 'unresolved-card');
        expect(findings).toEqual([]);
    });

    it('audit flags every body card as unresolved when bodies are blanked in memory', () => {
        // We DON'T trust the on-disk prompts-only file — the live VS
        // Code session can re-save it with content. Instead, blank the
        // bodies of the canonical project in memory and audit that.
        // This isolates the audit logic from working-tree drift.
        const p = loadProject('calculator.slate.json');
        let bodyCount = 0;
        for (const doc of p.getAllDocs()) {
            for (const card of doc.getAllCards()) {
                if (card.isHeader()) continue;
                bodyCount += 1;
                card.content = '';
            }
        }
        const findings = auditProject(p).filter(f => f.kind === 'unresolved-card');
        // Every body card with a non-empty prompt should now be flagged.
        expect(findings.length).toBe(bodyCount);
    });

    it('audit catches a synthetically-injected header forward-ref', () => {
        // Regression test for the exact bug the user hit. Build a copy
        // of operations doc with the bad lines re-injected, run the
        // audit, expect a finding.
        const p = loadProject('calculator.slate.json');
        const ops = p.getAllDocs().find(d => d.title === 'operations');
        const header = ops.cards[0];
        header.content =
            header.content + `\nOPS["+"] = add\nOPS["-"] = subtract\n`;
        const findings = auditProject(p).filter(f => f.kind === 'header-forward-ref');
        expect(findings.length).toBeGreaterThanOrEqual(1);
        const detail = findings.map(f => f.detail).join(' | ');
        expect(detail).toMatch(/header line .* references body symbol "add"/);
    });
});

/* ──────────────────────────── compile ─────────────────────────────── */

describe('calculator sample · compile', () => {
    let project;
    beforeAll(() => {
        project = loadProject('calculator.slate.json');
    });

    it('compiles operations.py without forward-ref module-scope statements', () => {
        const ops = project.getAllDocs().find(d => d.title === 'operations');
        const { source, filename } = compileDocToPython(ops, project);
        expect(filename).toBe('operations.py');
        // Lift every body symbol name and the line index where it's
        // defined; assert no usage line appears earlier than the def.
        const defOrder = {};
        const lines = source.split('\n');
        lines.forEach((ln, i) => {
            const m = /^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(ln);
            if (m && !(m[1] in defOrder)) defOrder[m[1]] = i;
        });
        for (const sym of Object.keys(defOrder)) {
            const defIdx = defOrder[sym];
            for (let i = 0; i < defIdx; i++) {
                const ln = lines[i];
                if (!ln) continue;
                const trimmed = ln.trim();
                if (trimmed.startsWith('#')) continue;
                if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) continue;
                if (trimmed.startsWith('from ') || trimmed.startsWith('import ')) continue;
                // RHS-of-assignment scan only — header may legitimately
                // declare `OPS: Dict[...] = {}`.
                const eqIdx = trimmed.indexOf('=');
                const rhs = eqIdx >= 0 ? trimmed.slice(eqIdx + 1) : trimmed;
                expect(
                    new RegExp(`\\b${sym}\\b`).test(rhs),
                    `pre-def line ${i} ("${trimmed}") references body symbol "${sym}" defined at line ${defIdx}`
                ).toBe(false);
            }
        }
    });

    it('compiles calculator.py with the cross-doc import line at top', () => {
        const calc = project.getAllDocs().find(d => d.title === 'calculator');
        const { source, filename } = compileDocToPython(calc, project);
        expect(filename).toBe('calculator.py');
        expect(source).toMatch(/from operations import .*OPS/);
    });

    it('compileDocToPython is deterministic — second run = first run', () => {
        const ops = project.getAllDocs().find(d => d.title === 'operations');
        const a = compileDocToPython(ops, project).source;
        const b = compileDocToPython(ops, project).source;
        expect(b).toBe(a);
    });
});

/* ─────────────────────── bibliography / @-refs ───────────────────────── */

describe('calculator sample · bibliography (info retrieval)', () => {
    let project;
    beforeAll(() => { project = loadProject('calculator.slate.json'); });

    it('resolves intra-doc @-refs in code mode (raw python)', () => {
        const ops = project.getAllDocs().find(d => d.title === 'operations');
        // register_ops references @add @subtract @multiply @divide.
        const bib = buildBibliography(
            ['add', 'subtract', 'multiply', 'divide'],
            ops, project,
            { codeMode: true },
        );
        expect(bib).toMatch(/def add/);
        expect(bib).toMatch(/def subtract/);
        expect(bib).toMatch(/def multiply/);
        expect(bib).toMatch(/def divide/);
    });

    it('resolves cross-doc @-refs from calculator into operations', () => {
        const calc = project.getAllDocs().find(d => d.title === 'calculator');
        const bib = buildBibliography(
            ['register_ops', 'apply_operation'],
            calc, project,
            { codeMode: true },
        );
        expect(bib).toMatch(/def register_ops/);
        expect(bib).toMatch(/def apply_operation/);
    });

    it('auto-includes the current doc header when asked', () => {
        const calc = project.getAllDocs().find(d => d.title === 'calculator');
        const bib = buildBibliography(
            [],
            calc, project,
            { codeMode: true, includeCurrentDocHeader: true },
        );
        expect(bib).toMatch(/from operations import/);
    });
});

/* ─────────────── #50 header-additions split + apply ──────────────────── */

describe('chat_ctl · header-additions schema (#50)', () => {
    it('split: no marker → all body, no additions', () => {
        const out = splitFunctionAndHeaderAdditions('def foo():\n    pass\n');
        expect(out.functionSrc.trim()).toBe('def foo():\n    pass');
        expect(out.headerAdditions).toEqual([]);
    });

    it('split: marker present → body + additions', () => {
        const text = 'def foo():\n    return PI\n# @slate:header-additions\nfrom math import pi as PI\n';
        const out = splitFunctionAndHeaderAdditions(text);
        expect(out.functionSrc).toContain('def foo():');
        expect(out.headerAdditions).toEqual(['from math import pi as PI']);
    });

    it('apply: append-only, dedupes against existing header', () => {
        const before = '"""doc."""\nfrom math import pi\n';
        const after = applyHeaderAdditions(before, ['from math import pi', 'from math import e']);
        // `from math import pi` should NOT be added again.
        const piMatches = after.match(/from math import pi$/gm) || [];
        expect(piMatches.length).toBe(1);
        expect(after).toMatch(/from math import e/);
    });

    it('apply: never reorders or deletes existing header lines', () => {
        const before = '"""doc."""\nfrom math import pi\n# stable comment\nX = 1\n';
        const after = applyHeaderAdditions(before, ['from math import e']);
        expect(after.startsWith(before.trimEnd())).toBe(true);
    });
});

/* ───────────── header-addition safety filter (the calc fix) ─────────────── */

describe('chat_ctl · isSafeHeaderAdditionLine', () => {
    it.each([
        '',                                              // blank
        '# a comment',
        'import os',
        'import os.path',
        'import numpy as np',
        'from typing import Callable, Dict',
        'from typing import (Callable, Dict)',
        'from . import utils',
        'PI = 3.14',
        'NAME: str = "slate"',
        'COUNT: int = 0',
        'EMPTY: list = []',
        'OPS: Dict[str, Callable[[float, float], float]] = {}',
        'TIMEOUT_SEC: Final[float] = 5.0',
    ])('accepts safe line: %s', (line) => {
        expect(isSafeHeaderAdditionLine(line)).toBe(true);
    });

    it.each([
        'OPS["+"] = add',                                // THE bug
        "OPS['-'] = subtract",
        'HANDLERS = [foo, bar]',
        'register_ops()',
        'print("hello")',
        'CONFIG = build_config()',
        'X = some_helper(1, 2)',
        'OPS.clear()',
        'main()',
        'a = b',                                         // RHS is unknown name
    ])('rejects unsafe line: %s', (line) => {
        expect(isSafeHeaderAdditionLine(line)).toBe(false);
    });

    it('apply: drops the OPS["+"] = add lines emitted by the model', () => {
        const before = '"""doc."""\nfrom typing import Callable, Dict\nOPS: Dict[str, Callable] = {}\n';
        const after = applyHeaderAdditions(before, [
            'OPS["+"] = add',
            'OPS["-"] = subtract',
            'OPS["*"] = multiply',
            'OPS["/"] = divide',
        ]);
        // Header is unchanged because every addition was unsafe.
        expect(after).toBe(before);
        expect(after).not.toMatch(/OPS\["\+"\]\s*=\s*add/);
    });

    it('apply: keeps safe additions and drops only the unsafe ones in a mixed batch', () => {
        const before = '"""doc."""\n';
        const after = applyHeaderAdditions(before, [
            'from math import pi',           // safe — kept
            'OPS["+"] = add',                // unsafe — dropped
            'PI: float = 3.14159',           // safe — kept
            'register_ops()',                // unsafe — dropped
        ]);
        expect(after).toMatch(/from math import pi/);
        expect(after).toMatch(/PI: float = 3.14159/);
        expect(after).not.toMatch(/OPS\["\+"\]/);
        expect(after).not.toMatch(/register_ops/);
    });
});
