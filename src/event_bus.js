/**
 * event_bus.js — tiny pub/sub for decoupling controllers from applets.
 *
 * Use this instead of direct method calls when:
 *   - An applet needs to tell controllers "the user did X" without knowing
 *     which controller will handle it.
 *   - A controller mutates the model and needs to tell every interested
 *     applet to re-render, without holding refs to them.
 *
 * Don't use this for:
 *   - Synchronous request/response inside a single layer (just call the
 *     function).
 *   - Crossing the host_bridge boundary (that's `postToHost` / postMessage).
 *
 * Event naming convention: `<noun>:<verb>` in past tense for facts
 * ("card:added", "doc:loaded") and present tense for intents
 * ("send:requested", "freeze:requested"). Applets emit intents; controllers
 * emit facts.
 */

const _listeners = new Map(); // event name → Set<handler>

/**
 * Subscribe to an event. Returns an unsubscribe function — store it and call
 * it on applet destroy() to avoid leaks.
 *
 * @param {string} event
 * @param {(payload: any) => void} handler
 * @returns {() => void} unsubscribe
 */
export function on(event, handler) {
    if (typeof handler !== 'function') {
        throw new Error(`event_bus.on: handler for "${event}" is not a function`);
    }
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(handler);
    return () => off(event, handler);
}

/**
 * Subscribe once; auto-unsubscribes after the first invocation.
 */
export function once(event, handler) {
    const unsub = on(event, (payload) => {
        unsub();
        handler(payload);
    });
    return unsub;
}

/**
 * Unsubscribe a specific handler.
 */
export function off(event, handler) {
    const set = _listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) _listeners.delete(event);
}

/**
 * Emit an event synchronously. Each handler is wrapped in try/catch so a
 * single bad listener can't break the broadcast.
 *
 * @param {string} event
 * @param {any} [payload]
 */
export function emit(event, payload) {
    const set = _listeners.get(event);
    if (!set) return;
    // Snapshot so a handler that unsubscribes mid-iteration doesn't mutate
    // the set we're walking.
    for (const handler of [...set]) {
        try {
            handler(payload);
        } catch (err) {
            console.error(`event_bus: handler for "${event}" threw`, err);
        }
    }
}

/**
 * Test helper: drop every listener. ONLY for unit tests.
 */
export function __resetForTests() {
    _listeners.clear();
}
