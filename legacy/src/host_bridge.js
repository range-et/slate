/**
 * Host bridge: emits compiled Python to whichever environment slate is running in.
 * - VS Code webview: posts a `compile` message to the extension host, which writes
 *   the file via `vscode.workspace.fs.writeFile`.
 * - Browser: triggers a download via a synthesized <a download>.
 */

function getVsCodeApi() {
    // The extension injects acquireVsCodeApi (one-shot). We cache the handle
    // so multiple calls don't throw.
    if (typeof window === 'undefined') return null;
    if (window.__slateVscode) return window.__slateVscode;
    if (typeof window.acquireVsCodeApi === 'function') {
        try {
            window.__slateVscode = window.acquireVsCodeApi();
            return window.__slateVscode;
        } catch (err) {
            console.warn('acquireVsCodeApi failed:', err);
        }
    }
    return null;
}

export function isRunningInVsCode() {
    return !!getVsCodeApi();
}

export function saveCompiled({ filename, source, destination = '' }) {
    if (!filename || typeof source !== 'string') {
        throw new Error('saveCompiled: filename and source are required.');
    }

    const vscode = getVsCodeApi();
    if (vscode) {
        vscode.postMessage({ type: 'compile', filename, source, destination });
        return { delivered: 'vscode' };
    }

    // Browser fallback: trigger a download. Destination is informational only —
    // the browser's download flow can't write into a subdir, so we prefix the
    // suggested filename with a flattened path hint.
    const flatHint = destination ? destination.replace(/[\/\\]+/g, '_') + '__' : '';
    const blob = new Blob([source], { type: 'text/x-python;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${flatHint}${filename}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { delivered: 'browser' };
}

/**
 * Ask the host to read a doc's compiled .py back from disk and post a
 * `rehydrate-result` message with its current source. Browser host has no disk
 * to read from, so this returns false there.
 */
export function requestRehydrate({ filename, destination = '', docId }) {
    const vscode = getVsCodeApi();
    if (!vscode) return false;
    vscode.postMessage({ type: 'rehydrate', filename, destination, docId });
    return true;
}

/**
 * Send a fire-and-forget message to the host (used by the state-bridge to
 * round-trip localStorage writes through the extension's globalState).
 */
export function postToHost(message) {
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage(message);
}
