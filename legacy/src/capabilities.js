/**
 * capabilities.js — single source of truth for the feature × target matrix.
 *
 * Every applet, controller, and view that has target-specific behavior MUST
 * read its decision from `caps` here. Never sprinkle `if (isRunningInVsCode())`
 * checks elsewhere — add the capability key to the matrix below and gate on it.
 *
 * Adding a new capability:
 *   1. Add a key to BOTH target rows in CAPABILITIES (default false).
 *   2. Use `can('yourKey')` at the call site that mounts/wires the feature.
 *   3. Mention the new key in ARCHITECTURE.md § Capability matrix.
 *
 * Adding a new target (e.g. 'jetbrains', 'electron-desktop'):
 *   1. Add a row to CAPABILITIES.
 *   2. Extend detectTarget() with a runtime probe.
 *   3. Document the row in ARCHITECTURE.md.
 */

/** @typedef {'web' | 'vscode'} Target */

/**
 * Capability matrix. Keys are kebab-free camelCase. Values are either booleans
 * or small structured descriptors (e.g. compile.mode). Keep this flat and
 * declarative — no functions here. Functions belong in controllers/applets
 * that READ this file.
 */
export const CAPABILITIES = Object.freeze({
    web: Object.freeze({
        // Languages whose preset_schema applet should be mounted.
        languages: Object.freeze(['markdown', 'python']),

        // How CompileCtl ships output. 'download' triggers a browser download;
        // 'workspace-write' posts to the host extension via host_bridge.
        compile: Object.freeze({ mode: 'download' }),

        // Local Ollama is reachable from a VS Code webview but blocked by
        // CORS in a browser tab on GH Pages. Web build defaults to cloud.
        localModels: false,
        cloudModels: true,

        // Token-by-token render in the prompt area (#7 in issues.md).
        streaming: true,

        // ⌘⇧R hand-off button mounts only where a terminal exists.
        terminalHandoff: false,

        // vscode.workspace.fs read/write (e.g. .slate-map.json sidecar).
        workspaceFs: false,

        // Registers .slate.json as a custom editor view.
        customEditor: false,

        // Web-only: feedback widget, "try slate" landing tour, share-link button.
        feedbackWidget: true,
        landingTour: true,
        shareLink: true,

        // Where settings (api keys, model prefs) round-trip through.
        settingsRoute: 'localStorage',
    }),

    vscode: Object.freeze({
        languages: Object.freeze(['markdown', 'python', 'csharp', 'cpp', 'javascript']),
        compile: Object.freeze({ mode: 'workspace-write' }),
        localModels: true,
        cloudModels: true,
        streaming: true,
        terminalHandoff: true,
        workspaceFs: true,
        customEditor: true,
        feedbackWidget: false,
        landingTour: false,
        shareLink: false,
        settingsRoute: 'globalState',
    }),
});

/**
 * Runtime target detection. Probes for the VS Code webview API; everything
 * else is 'web'. Cached on first call.
 *
 * Note: this is a runtime detection, not a build flag. Both bundles include
 * both target rows of the matrix today. If we move to per-target builds
 * (Vite mode 'web' vs 'vscode'), replace the body with `import.meta.env.MODE`
 * and tree-shake the unused row.
 *
 * @returns {Target}
 */
let _cachedTarget = null;
export function detectTarget() {
    if (_cachedTarget) return _cachedTarget;
    if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
        _cachedTarget = 'vscode';
    } else {
        _cachedTarget = 'web';
    }
    return _cachedTarget;
}

/** Active target (frozen at first read). */
export const TARGET = detectTarget();

/** Active capability row. Always read from this in app code. */
export const caps = CAPABILITIES[TARGET];

/**
 * Ergonomic boolean check for binary capabilities. For structured caps
 * (e.g. caps.compile.mode), read `caps.compile.mode` directly.
 *
 * @example
 *   if (can('terminalHandoff')) mount(TerminalHandoffBtn);
 *
 * @param {keyof typeof caps} key
 * @returns {boolean}
 */
export function can(key) {
    return caps[key] === true;
}

/**
 * Test helper: override the detected target. ONLY for unit tests / Storybook.
 * Production code must never call this. Resets on next module reload.
 */
export function __setTargetForTests(target) {
    if (target !== 'web' && target !== 'vscode') {
        throw new Error(`__setTargetForTests: invalid target ${target}`);
    }
    _cachedTarget = target;
}
