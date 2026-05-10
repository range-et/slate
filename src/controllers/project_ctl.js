/**
 * project_ctl.js — orchestrates project-level operations: create, export to
 * JSON file, import from file, hydrate from JSON, search, name input wiring,
 * host-side change notification.
 *
 * Boundaries:
 *   - DOES use:   Project / Doc / Card models, sanitizeTitle, host_bridge
 *                 (postToHost), generateRandomName, modal (via ctx).
 *   - Does NOT:   know about applets or other controllers; calls back into
 *                 main_script via ctx.* for cross-cutting effects (viz,
 *                 chat sync, doc switching).
 *
 * Init context:
 *   getProject() / setProject(p)
 *   getCurrentDoc() / setCurrentDoc(d)
 *   getModal()
 *   getButtons()
 *   getDocContent()
 *   updateViz()
 *   syncChat()
 *   clearChat()
 *   switchToDoc(doc)              — supplied by doc_ctl
 *   onProjectChanged()            — bumps a dirty flag and posts to host
 *
 * Note: load-from-JSON is the most invasive operation here — it tears down
 * the existing project, builds a fresh Project tree from JSON, swaps in the
 * first doc, re-mounts every Card, and refreshes the viz. The bootstrap
 * still owns the Card factory (so it can attach the right callbacks); we
 * accept a `cardFactory` in ctx for that.
 */

import Project from '../project.js';
import Doc from '../doc.js';
import { sanitizeTitle } from '../ai_chat.js';
import generateRandomName from '../random_name_generator.js';

let _ctx = null;

export function initProjectCtl(ctx) {
    _ctx = ctx;
}

/* ─── lifecycle ─────────────────────────────────────────────────────────── */

export function createProject(name) {
    const project = new Project(name);
    project.init();
    _ctx.setProject(project);
    return project;
}

/* ─── input wiring ──────────────────────────────────────────────────────── */

export function setupProjectTitleSanitization() {
    const input = _ctx.getButtons().project_title_input;
    input.addEventListener('blur', () => {
        if (input.value.trim() === '') return;
        input.value = sanitizeTitle(input.value);
        const project = _ctx.getProject();
        if (project) {
            project.updateName(input.value);
            _ctx.updateViz();
        }
    });
}

/* ─── export / import ───────────────────────────────────────────────────── */

export function exportProject() {
    const project = _ctx.getProject();
    const modal = _ctx.getModal();
    if (!project) {
        modal.alert('No project to export');
        return;
    }
    try {
        const projectData = project.toJSON();
        const jsonString = JSON.stringify(projectData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sanitizeTitle(project.name)}_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Export failed:', err);
        modal.alert('Export failed: ' + err.message);
    }
}

export async function importProject() {
    const modal = _ctx.getModal();
    const confirmed = await modal.confirm('Import project? Current project will be replaced.');
    if (!confirmed) return;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const projectData = JSON.parse(text);
            loadProjectFromJson(projectData);
            await modal.alert('Project imported successfully!');
        } catch (err) {
            console.error('Import failed:', err);
            await modal.alert(`Import failed: ${err.message}`);
        }
    };
    fileInput.click();
}

/**
 * Replace the current project with one rebuilt from a parsed JSON tree.
 * Wraps the rebuild in a `setHydrating(true/false)` window so the host
 * notification is suppressed for echoes that would otherwise loop back
 * through `load-state`.
 */
export function loadProjectFromJson(jsonData) {
    const importedProject = Project.fromJSON(jsonData);
    _ctx.setHydrating(true);
    try {
        _ctx.setProject(importedProject);
        const buttons = _ctx.getButtons();
        buttons.project_title_input.value = importedProject.name || '';

        _ctx.updateViz();

        if (importedProject.getDocCount() > 0) {
            _ctx.switchToDoc(importedProject.getAllDocs()[0]);
        } else {
            const newDocName = generateRandomName();
            buttons.doc_title_input.value = newDocName;
            const doc = new Doc(newDocName);
            doc.init();
            importedProject.addDoc(doc);
            _ctx.setCurrentDoc(doc);
            _ctx.updateViz();
        }

        // Final full chat reset (prompt + title + images) regardless of branch.
        _ctx.resetChat();
    } finally {
        _ctx.setHydrating(false);
    }
}

/* ─── change notification ───────────────────────────────────────────────── */

/**
 * Debounced notification to the host that the project state has changed.
 * No-op in plain browsers (no host to talk to) and during hydration. Records
 * the exact state we shipped so the immediate `load-state` echo can be
 * suppressed by the host message listener.
 */
let _notifyTimer = null;
export function notifyProjectChanged() {
    if (_ctx.isHydrating()) return;
    if (typeof window === 'undefined') return;
    if (!window.__slateVscode) return;
    if (_notifyTimer) clearTimeout(_notifyTimer);
    _notifyTimer = setTimeout(() => {
        _notifyTimer = null;
        const project = _ctx.getProject();
        if (!project) return;
        try {
            const json = JSON.stringify(project.toJSON(), null, 2);
            _ctx.recordLastSentState(json);
            window.__slateVscode.postMessage({ type: 'state-changed', state: json });
        } catch (err) {
            console.warn('Failed to serialize project for host:', err);
        }
    }, 250);
}

/* ─── search ────────────────────────────────────────────────────────────── */

/**
 * Search the project for a doc title or card title (exact then partial,
 * case-insensitive). On hit, switch to the owning doc and (if a card)
 * scroll it into view + briefly flash it.
 */
export async function searchAndNavigate() {
    const buttons = _ctx.getButtons();
    const modal = _ctx.getModal();
    const project = _ctx.getProject();
    const searchQuery = (buttons.search_input.value || '').trim().toLowerCase();
    if (!searchQuery) {
        await modal.alert('Please enter a search term');
        return;
    }
    if (!project) {
        await modal.alert('No project loaded');
        return;
    }

    const allDocs = project.getAllDocs();
    const docContent = _ctx.getDocContent();

    // Exact doc title match.
    const docMatch = allDocs.find(d => d.title.toLowerCase() === searchQuery);
    if (docMatch) {
        _ctx.switchToDoc(docMatch);
        buttons.search_input.value = '';
        return;
    }

    // Exact card title match.
    for (const doc of allDocs) {
        const cardMatch = doc.getAllCards().find(c => c.title.toLowerCase() === searchQuery);
        if (cardMatch) {
            _ctx.switchToDoc(doc);
            setTimeout(() => {
                const cardElement = Array.from(docContent.querySelectorAll('.card')).find(el => {
                    const titleEl = el.querySelector('h4');
                    return titleEl && titleEl.textContent.toLowerCase() === searchQuery;
                });
                if (cardElement) {
                    cardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    cardElement.classList.add('card--flash');
                    setTimeout(() => cardElement.classList.remove('card--flash'), 500);
                }
            }, 100);
            buttons.search_input.value = '';
            return;
        }
    }

    // Partial doc match.
    const docPartial = allDocs.find(d => d.title.toLowerCase().includes(searchQuery));
    if (docPartial) {
        _ctx.switchToDoc(docPartial);
        buttons.search_input.value = '';
        return;
    }

    // Partial card match.
    for (const doc of allDocs) {
        const cardPartial = doc.getAllCards().find(c =>
            c.title.toLowerCase().includes(searchQuery)
        );
        if (cardPartial) {
            _ctx.switchToDoc(doc);
            buttons.search_input.value = '';
            return;
        }
    }

    await modal.alert(`No results found for "${searchQuery}"`);
}

/** Test-only. */
export function __resetForTests() { _ctx = null; }
