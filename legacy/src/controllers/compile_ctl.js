/**
 * compile_ctl.js — orchestrates compiling a doc to source and shipping the
 * output via the host bridge. The first controller extracted from
 * main_script.js per ARCHITECTURE.md § Phase B.
 *
 * Boundaries:
 *   - DOES use:    code_compile (pure compiler), host_bridge (target IO),
 *                  event_bus (decoupling)
 *   - Does NOT use: any DOM API, any modal, any applet, mainManager
 *
 * Two surfaces:
 *
 *   1. Direct API (testable headless):
 *        compileDoc(doc, project) → { ok, ...result } | { ok: false, error }
 *
 *   2. Event bus (production wiring):
 *        emit('compile:requested', { doc, project })
 *          → controller compiles, then emits one of:
 *            'compile:succeeded' { filename, source, destination, warnings, delivery }
 *            'compile:failed'    { error }
 *
 * Note: the pure helpers in code_compile.js (sanitizeDocFilename,
 * extractInlineImports, etc.) are still imported elsewhere by callers that
 * need them for non-compile concerns (e.g. rehydrate). That's fine — they're
 * model-layer functions, not orchestration.
 */

import { compileDocToPython } from '../code_compile.js';
import { saveCompiled } from '../host_bridge.js';
import { on, emit } from '../event_bus.js';

let _initialized = false;

/**
 * Compile a doc and ship the result via host_bridge. Pure synchronous
 * function — returns a result object instead of throwing or touching the DOM.
 *
 * @param {object} doc      — the doc to compile (must have getAllCards)
 * @param {object} project  — the owning project (used for cross-doc @refs)
 * @returns {{ ok: true, filename, source, destination, warnings, delivery } |
 *           { ok: false, error: string }}
 */
export function compileDoc(doc, project) {
    if (!doc) return { ok: false, error: 'No document to compile.' };
    try {
        const { filename, source, destination, warnings } =
            compileDocToPython(doc, project);
        const delivery = saveCompiled({ filename, source, destination });
        return {
            ok: true,
            filename,
            source,
            destination,
            warnings: warnings || [],
            // 'vscode' (workspace write) | 'browser' (download)
            delivery: delivery && delivery.delivered,
        };
    } catch (err) {
        console.error('compile_ctl: compile failed:', err);
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
}

/**
 * Compile every doc in a project. Walks `project.getAllDocs()` and
 * runs `compileDoc()` once per doc, ignoring docs that have no compile
 * target (filename-less, or zero-cards) but reporting the rest.
 *
 * @param {object} project — must expose getAllDocs()
 * @returns {{
 *   ok: boolean,                  // true iff EVERY doc compiled cleanly
 *   results: Array<{
 *     docTitle: string,
 *     ok: boolean,
 *     filename?: string,
 *     destination?: string,
 *     warnings?: string[],
 *     delivery?: string,
 *     error?: string,
 *   }>,
 *   succeeded: number,
 *   failed: number,
 * }}
 */
export function compileProject(project) {
    const out = { ok: true, results: [], succeeded: 0, failed: 0 };
    if (!project || typeof project.getAllDocs !== 'function') {
        return { ...out, ok: false, results: [{ docTitle: '(none)', ok: false, error: 'No project to compile.' }], failed: 1 };
    }
    const docs = project.getAllDocs() || [];
    if (docs.length === 0) {
        return { ...out, ok: false, results: [{ docTitle: '(empty)', ok: false, error: 'Project has no documents.' }], failed: 1 };
    }
    for (const doc of docs) {
        const r = compileDoc(doc, project);
        const entry = { docTitle: doc.title, ...r };
        out.results.push(entry);
        if (r.ok) out.succeeded += 1;
        else { out.failed += 1; out.ok = false; }
    }
    return out;
}

/**
 * Wire `compile:requested` → compile → `compile:succeeded` / `compile:failed`.
 * Idempotent: safe to call from any bootstrap that happens to run twice.
 */
export function initCompileCtl() {
    if (_initialized) return;
    _initialized = true;
    on('compile:requested', ({ doc, project } = {}) => {
        const result = compileDoc(doc, project);
        if (result.ok) {
            emit('compile:succeeded', result);
        } else {
            emit('compile:failed', { error: result.error });
        }
    });
}

/** Test-only: reset the init guard so a fresh `initCompileCtl()` re-binds. */
export function __resetForTests() {
    _initialized = false;
}
