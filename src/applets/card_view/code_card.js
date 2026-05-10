/**
 * code_card renderer — body card holding raw Python source. Renders the
 * source as a syntax-highlighted block using the same highlight stack as
 * the live editor (highlightCodeStatic), so colors stay consistent.
 *
 * (Phase C-b, issue #45.)
 */
import { register } from './registry.js';
import { highlightCodeStatic } from '../../codemirror_setup.js';
import { defaultBodyActions } from './_shared.js';

register('code', {
    classes: ['card--code'],

    renderContent(card) {
        const src = card.getPythonSource() || '';
        return `<pre class="card-code-block language-python"><code>${highlightCodeStatic(src, 'python')}</code></pre>`;
    },

    renderActions: defaultBodyActions,
    renderKindPill: () => '',
});
