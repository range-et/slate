// Slate ↔ VS Code state bridge.
// Runs synchronously inside the webview before main_script.js loads.
// Monkeypatches window.localStorage so slate's existing localStorage reads/writes
// round-trip through the extension host's globalState across VS Code restarts.
//
// Reads stay sync via an in-memory cache seeded from window.__slateInitialState
// (which the extension bakes into the HTML). Writes update the cache immediately
// and post a 'state-write' message to the host for async persistence.
(function () {
    var initial = window.__slateInitialState || {};
    var cache = Object.assign({}, initial);

    var vscode = null;
    if (typeof window.acquireVsCodeApi === 'function') {
        try { vscode = window.acquireVsCodeApi(); } catch (e) { /* already acquired */ }
    }
    // Cache for host_bridge.js to reuse without re-acquiring.
    if (vscode) {
        window.__slateVscode = vscode;
        // Tag the document so styles.css can scope down font/border for VS Code chrome.
        if (document.documentElement) {
            document.documentElement.classList.add('slate-host-vscode');
        }
    }

    function flush(key, value) {
        if (!vscode) return;
        vscode.postMessage({ type: 'state-write', key: key, value: value });
    }

    // Build a fresh Storage-shaped object backed by the cache.
    var storage = {
        getItem: function (key) {
            return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
        },
        setItem: function (key, value) {
            cache[key] = String(value);
            flush(key, cache[key]);
        },
        removeItem: function (key) {
            delete cache[key];
            flush(key, null);
        },
        clear: function () {
            Object.keys(cache).forEach(function (k) { flush(k, null); });
            cache = {};
        },
        key: function (i) {
            var keys = Object.keys(cache);
            return i >= 0 && i < keys.length ? keys[i] : null;
        }
    };
    Object.defineProperty(storage, 'length', { get: function () { return Object.keys(cache).length; } });

    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: function () { return storage; }
    });
})();
