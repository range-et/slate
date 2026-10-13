/**
 * header_card renderer — pinned, undeletable, undragable card at index 0
 * of every doc. Holds module-scope setup (imports, constants, type
 * aliases). Auto-included in every prompt's bibliography (#49).
 *
 * (Phase C-b, issue #45.)
 */
import { register } from './registry.js';
import { highlightCodeStatic } from '../../codemirror_setup.js';

register('header', {
    classes: ['card--header'],

    renderContent(card) {
        const src = (card.content || '').trim();
        return src
            ? `<pre class="card-code-block language-python"><code>${highlightCodeStatic(src, 'python')}</code></pre>`
            : `<p class="card-header-empty">Empty header. Edit (✎) to add module-scope imports, constants, or type aliases.</p>`;
    },

    renderActions() {
        // Headers are pinned: no remove, no move. Edit + summarize.
        // The SUM button is owned by `applets/summarize_header/`, which
        // attaches a document-level delegated listener, so we just
        // emit the markup here — no per-card binding needed.
        return `
            <button class="info_btn card-summarize-btn" title="Generate a doc-overview docstring from this doc's cards (replaces any existing top-of-file docstring)">SUM</button>
            <button class="success_btn card-edit-btn" title="Edit module-scope setup">✎</button>
        `;
    },

    renderKindPill() {
        return `<span class="card-kind-pill card-kind-pill--header" title="Module-scope setup, prepended to compiled output and to every code card's bibliography">header</span>`;
    },
});
