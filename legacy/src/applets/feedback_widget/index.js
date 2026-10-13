/**
 * feedback_widget — opens the public Slate feedback form in a new tab when
 * the FEEDBACK button is clicked. Web-only by capability gate.
 *
 * Phase C-c, issue #46.
 *
 * Convention: mount(deps) → { destroy }. Mount is UNCONDITIONAL; the
 * applet itself reads `caps.feedbackWidget` and no-ops (also hides its
 * own button) when the capability is false. That way the bootstrap stays
 * dumb and never has to know which target it's running in.
 */
import { can } from '../../capabilities.js';

const FEEDBACK_FORM_URL = 'https://forms.gle/BVk3YMzqoRELDy2C9';

let _state = null;

export function mount({ buttons }) {
    if (_state) destroyImpl();
    const btn = buttons && buttons.feedback_btn;
    if (!btn) return { destroy: () => {} };

    if (!can('feedbackWidget')) {
        btn.style.display = 'none';
        return { destroy: () => {} };
    }

    const onClick = () => window.open(FEEDBACK_FORM_URL, '_blank');
    btn.addEventListener('click', onClick);
    _state = { btn, onClick };

    return { destroy: destroyImpl };
}

function destroyImpl() {
    if (!_state) return;
    _state.btn.removeEventListener('click', _state.onClick);
    _state = null;
}
