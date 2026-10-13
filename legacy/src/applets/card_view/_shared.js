/**
 * Tiny shared helpers used by more than one card_view renderer.
 * (Phase C-b, issue #45.)
 *
 * Keep this file SMALL — anything more than a few lines per helper means
 * the helper probably belongs in its own per-kind file or in the registry
 * surface itself.
 */

/**
 * Body-card actions: edit + move + remove. Used by code_card and
 * markdown_card. header_card has its own (edit-only) actions; class_card
 * reuses this one in the Phase 5 placeholder.
 */
export function defaultBodyActions() {
    return `<button class="success_btn card-edit-btn" title="Edit this card in the prompt pane">✎</button>
            <button class="info_btn card-move-btn" title="Move to another document">↗</button>
            <button class="alert_btn" title="Remove card">x</button>`;
}
