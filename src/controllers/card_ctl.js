/**
 * card_ctl.js — orchestrates card-level operations. Currently focused on
 * the rehydrate flow (compiled .py → cards) and re-attaching event
 * listeners to cards already in the DOM at boot time. Future home (per
 * ARCHITECTURE.md § Phase B → Phase 6 spec issues #17/#18/#19) for the
 * draft / freeze / regenerate ceremony.
 *
 * Boundaries:
 *   - DOES use:   Card / Doc models, host_bridge.requestRehydrate,
 *                 sanitizeDocFilename, scanPythonSource.
 *   - Does NOT:   know about chat_ctl or compile_ctl; coordinates state
 *                 via ctx.switchToDoc(), ctx.updateViz(), etc.
 *
 * Init context:
 *   getProject()
 *   getCurrentDoc()
 *   getModal()
 *   getDocContent()
 *   switchToDoc(doc)
 *   updateViz()
 */

import Card, { CARD_TYPE_CODE } from '../cards.js';
import { sanitizeDocFilename } from '../code_compile.js';
import { requestRehydrate } from '../host_bridge.js';
import { scanPythonSource } from '../python_parser.js';
import { v4 as uuidv4 } from 'uuid';

let _ctx = null;

export function initCardCtl(ctx) {
    _ctx = ctx;
}

/* ─── rehydrate (compiled .py → cards) ──────────────────────────────────── */

/**
 * Ask the host to read this doc's compiled .py off disk so we can re-parse
 * it. Browser host has no disk — falls back to a paste-source modal.
 */
export async function rehydrateCurrentDoc() {
    const doc = _ctx.getCurrentDoc();
    const modal = _ctx.getModal();
    if (!doc) {
        await modal.alert('No document to rehydrate.');
        return;
    }
    const docId = doc.id;
    const docName = sanitizeDocFilename(doc.title);
    const filename = `${docName}.py`;
    const destination = doc.destination || '';
    const ok = requestRehydrate({ filename, destination, docId });
    if (ok) return;

    // Browser fallback: prompt the user to paste source.
    const container = document.createElement('div');
    container.innerHTML = `
        <h4 style="margin-bottom: 8px;">Rehydrate "${doc.title}"</h4>
        <p style="font-size: small; margin-bottom: 8px;">Paste the current contents of <code>${filename}</code> below. Slate will re-derive cards from the top-level <code>def</code>/<code>class</code> blocks.</p>
        <textarea id="rehydrate_source" rows="14"
            style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small;
                   background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2);"></textarea>
    `;
    const result = await modal.custom(container, [
        { text: 'Cancel', className: 'alert_btn', callback: () => null },
        {
            text: 'Rehydrate',
            className: 'success_btn',
            callback: () => document.getElementById('rehydrate_source').value,
        },
    ]);
    if (result === null || typeof result !== 'string') return;
    await applyRehydrate({ docId, source: result, filename });
}

/**
 * Replace the doc's code cards with what's in `source`. Existing code cards
 * with matching titles keep their id and prompt; their content updates.
 * New blocks become new cards. Code cards no longer in the file are removed.
 * Markdown cards are left untouched — they don't compile, so they don't
 * rehydrate.
 */
export async function applyRehydrate({ docId, source, filename, error }) {
    const modal = _ctx.getModal();
    if (error) {
        await modal.alert(`Rehydrate failed: ${error}`);
        return;
    }
    const project = _ctx.getProject();
    const doc = project ? project.getDoc(docId) : null;
    const target = doc || _ctx.getCurrentDoc();
    if (!target) {
        await modal.alert('Rehydrate target doc no longer exists.');
        return;
    }
    if (typeof source !== 'string') {
        await modal.alert(`Rehydrate failed: no source returned for ${filename || target.title}.`);
        return;
    }

    const { blocks, imports } = scanPythonSource(source);
    if (blocks.length === 0) {
        await modal.alert(`Rehydrate: ${filename || target.title} contained no top-level def/class blocks.`);
        return;
    }

    const existingByTitle = new Map();
    target.getAllCards().forEach(c => {
        if (c.cardType === CARD_TYPE_CODE) existingByTitle.set(c.title, c);
    });

    const seenTitles = new Set();
    const newCardOrder = [];
    const importHeader = imports.length ? imports.join('\n') + '\n\n' : '';

    let added = 0;
    let updated = 0;
    blocks.forEach((block, idx) => {
        seenTitles.add(block.name);
        // Stash all module-level imports on the first card so they survive
        // the next compile cycle.
        const blockSource = idx === 0 ? importHeader + block.source : block.source;
        const existing = existingByTitle.get(block.name);
        if (existing) {
            existing.content = blockSource;
            existing.prompt = existing.prompt || `imported from ${filename || target.title}`;
            newCardOrder.push(existing);
            updated++;
        } else {
            const card = new Card(
                block.name,
                blockSource,
                modal,
                () => _ctx.updateViz(),
                `imported from ${filename || target.title}`,
                [],
                CARD_TYPE_CODE
            );
            card.id = uuidv4();
            card.parent = target;
            newCardOrder.push(card);
            added++;
        }
    });

    const removedTitles = [];
    const keptMarkdown = [];
    target.getAllCards().forEach(c => {
        if (c.cardType !== CARD_TYPE_CODE) {
            keptMarkdown.push(c);
        } else if (!seenTitles.has(c.title)) {
            removedTitles.push(c.title);
        }
    });

    target.cards = [...newCardOrder, ...keptMarkdown];
    target.updatedAt = new Date().toISOString();

    if (target === _ctx.getCurrentDoc()) {
        _ctx.switchToDoc(target);
    }
    _ctx.updateViz();

    const summary = [
        `${added} added`,
        `${updated} updated`,
        `${removedTitles.length} removed`,
    ].join(', ');
    const removedTxt = removedTitles.length
        ? `\n\nRemoved: ${removedTitles.join(', ')}`
        : '';
    await modal.alert(`Rehydrated "${target.title}" — ${summary}.${removedTxt}`);
}

/* ─── existing-card listeners (boot-time hydration) ─────────────────────── */

/**
 * The starter HTML in index.html ships with a couple of placeholder cards
 * already in the DOM. After the project model is built, we re-attach the
 * remove-button listener so they behave like real cards.
 */
export function attachExistingCardListeners() {
    const docContent = _ctx.getDocContent();
    const modal = _ctx.getModal();
    const cardElements = docContent.querySelectorAll('.card');
    cardElements.forEach(cardElement => {
        const removeBtn = cardElement.querySelector('.alert_btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', async () => {
                const confirmed = await modal.confirm('Are you sure you want to remove this card?');
                if (confirmed) cardElement.remove();
            });
        }
    });
}

/** Test-only. */
export function __resetForTests() { _ctx = null; }
