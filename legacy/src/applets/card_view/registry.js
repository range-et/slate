/**
 * card_view registry — pluggable renderers, one per render kind.
 * (Phase C-b, part of issue #45.)
 *
 * Each per-kind file (header_card.js, code_card.js, markdown_card.js,
 * class_card.js) calls `register(kindKey, renderer)` at import time.
 * `selectKindKey(card)` picks which renderer to use for a given Card.
 *
 * Renderer shape:
 *   {
 *     renderContent(card) → string  // inner HTML for the content body
 *     renderActions(card) → string  // inner HTML for the .card_actions div
 *     renderKindPill(card) → string // inner HTML for the optional kind pill (or '')
 *     classes: string[]             // extra CSS classes added to the card root
 *   }
 *
 * Adding a new kind = one new file under card_view/ + zero edits to the
 * other files (just an `import './my_kind_card.js';` line in index.js so
 * the registration runs).
 */

const _renderers = new Map();

export function register(kindKey, renderer) {
    _renderers.set(kindKey, renderer);
}

export function getRenderer(kindKey) {
    return _renderers.get(kindKey);
}

/**
 * Pick the render kind key for a Card. Header always wins; then class
 * (Phase 5); otherwise dispatch by cardType (code vs markdown).
 */
export function selectKindKey(card) {
    if (card && typeof card.isHeader === 'function' && card.isHeader()) return 'header';
    if (card && card.kind === 'class') return 'class';
    return card && card.cardType === 'code' ? 'code' : 'markdown';
}
