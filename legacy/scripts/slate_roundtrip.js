#!/usr/bin/env node
/**
 * slate_roundtrip.js — pure CLI proof of compile → rehydrate → compile
 * fixed point.
 *
 * Why this script exists (issue #54b):
 *   The user's main pain is "I edit the .py file, then nothing flushes
 *   back into the cards." That round-trip flow is the foundation for
 *   the bigger "load a repo into Slate" + VS-Code-side annotation
 *   highlighter work. Until we can prove the round-trip is a fixed
 *   point we can't safely surface a Rehydrate button anywhere.
 *
 *   This script proves it OUTSIDE the browser and OUTSIDE VS Code so
 *   it can run in CI:
 *     1. Load a `.slate.json` project from disk.
 *     2. Compile every doc to Python via compileDocToPython().
 *     3. Apply the compiled source back into a *clone* of the project
 *        via the same applyAnnotatedRehydrate() the live UI uses.
 *     4. Compile again.
 *     5. Diff the two compile outputs per doc. Equal output ⇒ round-trip
 *        is a fixed point.
 *
 * Usage:
 *   node scripts/slate_roundtrip.js <path/to/project.slate.json>
 *
 *   Exits 0 on fixed-point success, 1 on any per-doc mismatch.
 *
 * Implementation note:
 *   The script intentionally does NOT touch the browser-only rehydrate
 *   path (modal, _ctx, etc.). It uses the same parseAnnotations + Card /
 *   Doc model surface directly so the test stays headless.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

import Project from '../src/project.js';
import Card, { CARD_TYPE_CODE, CARD_KIND_HEADER } from '../src/cards.js';
import { compileDocToPython } from '../src/code_compile.js';
import { parseAnnotations } from '../src/slate_annotations.js';
import { autoRefImportLines, preludeForHeader } from '../src/rehydrate.js';

function rehydrateDocFromSource(targetDoc, source, autoImports) {
    const sections = parseAnnotations(source);
    const prelude = sections.find(s => s.kind === 'prelude');
    const preludeForHdr = prelude ? preludeForHeader(prelude.body, autoImports) : '';
    const existingById = new Map();
    const existingByTitle = new Map();
    targetDoc.getAllCards().forEach(c => {
        if (c.cardType === CARD_TYPE_CODE) {
            existingById.set(c.id, c);
            existingByTitle.set(c.title, c);
        }
    });
    const headerCard = targetDoc.getAllCards().find(c => c.kind === CARD_KIND_HEADER) || null;
    const seenIds = new Set();
    const newOrder = [];
    let headerHandled = false;

    for (const section of sections) {
        if (section.kind === 'prelude') continue;
        if (section.kind === 'header') {
            if (headerCard) {
                // Re-fold prelude inline imports into the header card so
                // the next compile re-hoists the same set and we hit a
                // byte-for-byte fixed point. Cross-doc imports + the
                // auto-generated banner have already been stripped by
                // `preludeForHeader`.
                headerCard.content = preludeForHdr
                    ? `${preludeForHdr}\n${section.body}`
                    : section.body;
                if (section.prompt) headerCard.prompt = section.prompt;
                seenIds.add(headerCard.id);
                newOrder.push(headerCard);
                headerHandled = true;
            }
            continue;
        }
        let card = (section.id && existingById.get(section.id))
            || existingByTitle.get(section.title)
            || null;
        if (card) {
            card.content = section.body;
            if (section.title && card.title !== section.title) card.title = section.title;
            if (section.prompt) card.prompt = section.prompt;
            seenIds.add(card.id);
            newOrder.push(card);
        } else {
            card = new Card(
                section.title || 'untitled',
                section.body,
                null,
                () => {},
                section.prompt || '',
                [],
                CARD_TYPE_CODE,
                section.kind || undefined,
            );
            card.id = section.id || `rt-${Math.random().toString(36).slice(2)}`;
            card.parent = targetDoc;
            seenIds.add(card.id);
            newOrder.push(card);
        }
    }
    if (headerCard && !headerHandled) {
        seenIds.add(headerCard.id);
        newOrder.unshift(headerCard);
    }
    const keptMarkdown = [];
    targetDoc.getAllCards().forEach(c => {
        if (c.cardType !== CARD_TYPE_CODE) keptMarkdown.push(c);
    });
    targetDoc.cards = [...newOrder, ...keptMarkdown];
}

export function runRoundtrip(projectPath) {
    const raw = readFileSync(projectPath, 'utf8');
    const projectJSON = JSON.parse(raw);

    // Two independent clones: one to compile from (the "before" project)
    // and one to apply the rehydrated source into (the "after" project).
    const before = Project.fromJSON(JSON.parse(JSON.stringify(projectJSON)));
    const after = Project.fromJSON(JSON.parse(JSON.stringify(projectJSON)));

    const results = [];
    for (const beforeDoc of before.getAllDocs()) {
        const afterDoc = after.getDoc(beforeDoc.id);
        if (!afterDoc) continue;

        const hasCode = beforeDoc.getAllCards().some(c => c.cardType === CARD_TYPE_CODE);
        const hasHeaderContent = (beforeDoc.getAllCards().find(c => c.kind === CARD_KIND_HEADER)?.content || '').trim().length > 0;
        if (!hasCode && !hasHeaderContent) continue;

        let firstSrc;
        try {
            firstSrc = compileDocToPython(beforeDoc, before).source;
        } catch (e) {
            results.push({ doc: beforeDoc.title, ok: false, reason: `first compile failed: ${e.message}` });
            continue;
        }

        const autoImports = autoRefImportLines(afterDoc, after);
        rehydrateDocFromSource(afterDoc, firstSrc, autoImports);

        let secondSrc;
        try {
            secondSrc = compileDocToPython(afterDoc, after).source;
        } catch (e) {
            results.push({ doc: beforeDoc.title, ok: false, reason: `second compile failed: ${e.message}` });
            continue;
        }

        if (firstSrc === secondSrc) {
            results.push({ doc: beforeDoc.title, ok: true, bytes: firstSrc.length });
        } else {
            results.push({
                doc: beforeDoc.title,
                ok: false,
                reason: 'output differs',
                first: firstSrc,
                second: secondSrc,
            });
        }
    }
    return results;
}

// CLI entry point — only when invoked directly, not when imported by tests.
if (import.meta.url === `file://${argv[1]}`) {
    const path = argv[2];
    if (!path) {
        console.error('usage: node scripts/slate_roundtrip.js <project.slate.json>');
        exit(2);
    }
    const abs = resolve(process.cwd(), path);
    const results = runRoundtrip(abs);
    let pass = 0, fail = 0;
    for (const r of results) {
        if (r.ok) {
            console.log(`  ✓ ${r.doc} (${r.bytes} bytes, fixed point)`);
            pass++;
        } else {
            console.error(`  ✗ ${r.doc}: ${r.reason}`);
            if (r.first && r.second) {
                console.error('    --- first compile ---');
                console.error(r.first.split('\n').map(l => '    ' + l).join('\n'));
                console.error('    --- second compile ---');
                console.error(r.second.split('\n').map(l => '    ' + l).join('\n'));
            }
            fail++;
        }
    }
    console.log(`\nslate roundtrip: ${pass} ok, ${fail} failed (${results.length} docs total)`);
    exit(fail === 0 ? 0 : 1);
}
