/**
 * class_card renderer — placeholder for v0.2 §5 (#13). Renders exactly
 * like a code card today plus a "class" pill so it's visually distinct.
 * Once #13 lands (`parentCardId`, nested method rendering), the real
 * tree-aware renderer goes in here — no changes to the other card_view
 * files needed.
 *
 * (Phase C-b, issue #45.)
 */
import { register } from './registry.js';
import { highlightCodeStatic } from '../../codemirror_setup.js';
import { defaultBodyActions } from './_shared.js';

register('class', {
    classes: ['card--code', 'card--class'],

    renderContent(card) {
        const src = (typeof card.getPythonSource === 'function' && card.getPythonSource()) || (card.content || '');
        return `<pre class="card-code-block language-python"><code>${highlightCodeStatic(src, 'python')}</code></pre>`;
    },

    renderActions: defaultBodyActions,
    renderKindPill: () => `<span class="card-kind-pill" title="Class card (Phase 5 — see #13)">class</span>`,
});
