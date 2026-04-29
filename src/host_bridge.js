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

export function saveCompiled({ filename, source }) {
    if (!filename || typeof source !== 'string') {
        throw new Error('saveCompiled: filename and source are required.');
    }

    const vscode = getVsCodeApi();
    if (vscode) {
        vscode.postMessage({ type: 'compile', filename, source });
        return { delivered: 'vscode' };
    }

    // Browser fallback: trigger a download.
    const blob = new Blob([source], { type: 'text/x-python;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { delivered: 'browser' };
}

/**
 * Send a fire-and-forget message to the host (used by the state-bridge to
 * round-trip localStorage writes through the extension's globalState).
 */
export function postToHost(message) {
    const vscode = getVsCodeApi();
    if (vscode) vscode.postMessage(message);
}
