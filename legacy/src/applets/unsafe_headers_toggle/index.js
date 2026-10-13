/**
 * unsafe_headers_toggle — small persistent checkbox in the project
 * panel header that lets the user opt OUT of the safety filter on
 * #50 header-additions.
 *
 * The filter (in chat_ctl.applyHeaderAdditions + isSafeHeaderAdditionLine)
 * normally drops AI-emitted header lines that reference body symbols
 * (the classic OPS["+"] = add bug). For testing edge cases or
 * intentional metaprogramming, the user might want to push those
 * lines through anyway. This checkbox flips the
 * `slate.allowUnsafeHeaders.v1` localStorage flag — chat_ctl reads
 * it lazily on every applyPendingHeaderAdditions call, so the change
 * takes effect immediately without a reload.
 *
 * Convention: mount(deps) → { destroy }. Mount is unconditional.
 */
import { ALLOW_UNSAFE_HEADERS_KEY } from '../../controllers/chat_ctl.js';

let _state = null;

export function mount({ host } = {}) {
    if (_state) destroyImpl();
    const mountHost = host
        || document.querySelector('.network_heading')
        || document.getElementById('network');
    if (!mountHost) return { destroy: () => {} };

    // Build a compact label-checkbox-label group; styles come from the
    // existing `.info_btn` and `.network_heading` rules.
    const wrap = document.createElement('label');
    wrap.className = 'unsafe-headers-toggle';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.style.fontSize = 'x-small';
    wrap.style.opacity = '0.85';
    wrap.style.cursor = 'pointer';
    wrap.title = 'When ON, AI-emitted header additions are appended verbatim — including forward-references like OPS["+"] = add. OFF (default) drops them.';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'unsafe_headers_toggle';
    let initial = false;
    try {
        initial = localStorage.getItem(ALLOW_UNSAFE_HEADERS_KEY) === '1';
    } catch { /* ignore */ }
    cb.checked = initial;

    const text = document.createElement('span');
    text.textContent = 'unsafe headers';

    wrap.appendChild(cb);
    wrap.appendChild(text);
    mountHost.appendChild(wrap);

    const onChange = () => {
        try {
            if (cb.checked) localStorage.setItem(ALLOW_UNSAFE_HEADERS_KEY, '1');
            else localStorage.removeItem(ALLOW_UNSAFE_HEADERS_KEY);
        } catch { /* ignore */ }
    };
    cb.addEventListener('change', onChange);

    _state = { wrap, cb, onChange };
    return { destroy: destroyImpl };
}

function destroyImpl() {
    if (!_state) return;
    _state.cb.removeEventListener('change', _state.onChange);
    if (_state.wrap.parentNode) _state.wrap.parentNode.removeChild(_state.wrap);
    _state = null;
}
