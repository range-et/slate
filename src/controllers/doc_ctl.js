/**
 * doc_ctl.js — orchestrates per-doc operations: create, remove, switch,
 * title/destination edits, summary lifecycle. Third controller in Phase B
 * per ARCHITECTURE.md.
 *
 * Boundaries:
 *   - DOES use:   Doc model, Project model (via ctx), modal (via ctx),
 *                 generateRandomName, sanitizeTitle/sanitizeDestination,
 *                 marked (for the summary modal).
 *   - Does NOT:   touch the network viz directly (calls ctx.updateViz()),
 *                 mount the chat manager (calls ctx.syncChat()), or know
 *                 about other controllers.
 *
 * Init context (passed in by main_script bootstrap):
 *   getProject()         → current Project | null
 *   getCurrentDoc()      → current Doc | null
 *   setCurrentDoc(doc)   → sets the active doc (no UI side effects)
 *   getModal()           → Modal instance
 *   getDocContent()      → the #doc-content DOM root
 *   getButtons()         → the buttons map
 *   updateViz()          → trigger NetworkViz refresh + notifyProjectChanged
 *   syncChat()           → push currentDoc into ChatManager
 *   clearChat()          → reset the chat surface (used after add/remove doc)
 *   notifyChange()       → flag the project as dirty (host save)
 */

import Doc, { sanitizeDestination } from '../doc.js';
import { sanitizeTitle } from '../ai_chat.js';
import generateRandomName from '../random_name_generator.js';
import { marked } from 'marked';

let _ctx = null;

export function initDocCtl(ctx) {
    _ctx = ctx;
}

/* ─── doc lifecycle ──────────────────────────────────────────────────────── */

/** Create + init + attach a doc to the active project. Returns the doc. */
export function createDoc(title) {
    const doc = new Doc(title);
    doc.init();
    _ctx.setCurrentDoc(doc);
    const project = _ctx.getProject();
    if (project) {
        project.addDoc(doc);
        _ctx.updateViz();
    }
    return doc;
}

/** "+ DOC" button handler: create a new doc with a random unique name. */
export function addNewDoc() {
    _ctx.getDocContent().innerHTML = '';
    let newDocName = generateRandomName();
    const project = _ctx.getProject();
    if (project) {
        while (project.docTitleExists(newDocName)) {
            newDocName = generateRandomName();
        }
    }
    _ctx.getButtons().doc_title_input.value = newDocName;
    createDoc(newDocName);
    _ctx.syncChat();
    _ctx.clearChat();
}

/** "− DOC" button handler: confirm + remove + switch to next or new. */
export async function removeCurrentDoc() {
    const doc = _ctx.getCurrentDoc();
    const modal = _ctx.getModal();
    if (!doc) {
        await modal.alert('No document to remove');
        return;
    }
    const cardCount = doc.getCardCount();
    const message = cardCount > 0
        ? `Remove "${doc.title}" and its ${cardCount} card(s)?`
        : `Remove "${doc.title}"?`;
    const confirmed = await modal.confirm(message);
    if (!confirmed) return;

    const docId = doc.id;
    const project = _ctx.getProject();
    if (project) project.removeDoc(docId);

    _ctx.getDocContent().innerHTML = '';

    if (project && project.getDocCount() > 0) {
        switchToDoc(project.getAllDocs()[0]);
    } else {
        const newDocName = generateRandomName();
        _ctx.getButtons().doc_title_input.value = newDocName;
        createDoc(newDocName);
        _ctx.syncChat();
        _ctx.clearChat();
    }

    _ctx.updateViz();
}

/** Render a doc's cards into doc_content; sync chat manager; update inputs. */
export function switchToDoc(doc) {
    _ctx.setCurrentDoc(doc);
    const buttons = _ctx.getButtons();
    buttons.doc_title_input.value = doc.title;
    if (buttons.doc_destination_input) {
        buttons.doc_destination_input.value = doc.destination || '';
    }
    const docContent = _ctx.getDocContent();
    docContent.innerHTML = '';
    const modal = _ctx.getModal();
    doc.getAllCards().forEach(card => {
        if (!card.updateNetworkCallback) {
            card.updateNetworkCallback = () => _ctx.updateViz();
        }
        if (!card.modal) card.modal = modal;
        card.init();
        docContent.appendChild(card.innerHTML);
    });
    _ctx.syncChat();
}

/* ─── input wiring ───────────────────────────────────────────────────────── */

export function setupDocTitleSanitization() {
    const input = _ctx.getButtons().doc_title_input;
    input.addEventListener('blur', () => {
        if (input.value.trim() === '') return;
        let sanitized = sanitizeTitle(input.value);
        const doc = _ctx.getCurrentDoc();
        const project = _ctx.getProject();
        if (doc && project) {
            if (sanitized !== doc.title) {
                sanitized = project.getUniqueDocTitle(sanitized);
            }
            input.value = sanitized;
            doc.updateTitle(sanitized);
            _ctx.updateViz();
        }
    });
}

export function setupDocDestinationInput() {
    const input = _ctx.getButtons().doc_destination_input;
    if (!input) return;
    input.addEventListener('blur', () => {
        const cleaned = sanitizeDestination(input.value);
        input.value = cleaned;
        const doc = _ctx.getCurrentDoc();
        if (doc && doc.destination !== cleaned) {
            doc.updateDestination(cleaned);
            _ctx.notifyChange();
        }
    });
}

/* ─── summary lifecycle ──────────────────────────────────────────────────── */

/** "SUMMARY" button: show the current doc's summary, or a status message. */
export async function showDocSummary() {
    const doc = _ctx.getCurrentDoc();
    const modal = _ctx.getModal();
    if (!doc) { await modal.alert('No document to summarize'); return; }
    if (doc.summaryGenerating) {
        await modal.alert('Summary is still being generated. Please wait...');
        return;
    }
    if (doc.summaryError) {
        await modal.alert(`Summary generation failed: ${doc.summaryError}\n\nTry adding another card to regenerate.`);
        return;
    }
    if (!doc.summary) {
        await modal.alert('No summary available yet. Summary will be generated when you add cards to the document.');
        return;
    }
    const container = document.createElement('div');
    container.innerHTML = `
        <h4 style="margin-bottom: 15px;">Summary of "${doc.title}"</h4>
        <div class="markdown-body" style="max-height: 400px; overflow-y: auto; padding: 10px; background: var(--strata-layer-01); border: 1px solid var(--strata-interactive);">
            ${marked.parse(doc.summary)}
        </div>
    `;
    await modal.custom(container, [
        { text: 'Close', className: 'info_btn', callback: () => null },
    ]);
}

export function startSummaryAnimation() {
    const btn = _ctx.getButtons().summary_btn;
    if (!btn) return;
    btn.classList.remove('summary-error', 'summary-success');
    btn.classList.add('summary-generating');
}

export function summarySuccess() {
    _ctx.notifyChange();
    const btn = _ctx.getButtons().summary_btn;
    if (!btn) return;
    btn.classList.remove('summary-generating');
    btn.classList.add('summary-success');
    setTimeout(() => {
        if (btn) {
            btn.classList.remove('summary-success');
            btn.style.removeProperty('background');
            btn.style.removeProperty('color');
        }
    }, 3000);
}

export function summaryError(errorMessage) {
    const btn = _ctx.getButtons().summary_btn;
    if (!btn) return;
    btn.classList.remove('summary-generating');
    btn.classList.add('summary-error');
    _ctx.getModal().alert(`Summary generation failed: ${errorMessage}`);
}

/** Test-only. */
export function __resetForTests() { _ctx = null; }
