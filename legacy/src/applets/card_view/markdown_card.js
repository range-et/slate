/**
 * markdown_card renderer — body card holding markdown prose. Renders via
 * marked.parse with the same options the legacy renderer used (GFM,
 * <br> on newline, no header IDs, no email mangling).
 *
 * (Phase C-b, issue #45.)
 */
import { register } from './registry.js';
import { marked } from 'marked';
import { defaultBodyActions } from './_shared.js';

// Module-scope marked config. Set once at import time so every render
// path sees consistent behavior.
marked.setOptions({
    breaks: true,        // Convert \n to <br>
    gfm: true,           // GitHub Flavored Markdown
    headerIds: false,    // Don't add IDs to headers
    mangle: false        // Don't escape email addresses
});

register('markdown', {
    classes: [],

    renderContent(card) {
        return marked.parse(card.content || '');
    },

    renderActions: defaultBodyActions,
    renderKindPill: () => '',
});
