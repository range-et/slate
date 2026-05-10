/**
 * card_view — renders a Card model into a DOM element. (Phase C-b,
 * issue #45.)
 *
 * Surface:
 *   renderCard(card) → HTMLElement   // ready to insert; caller binds events
 *
 * Boundaries:
 *   - DOES use:   the Card model's read-only API (title, id, kind,
 *                 cardType, content, prompt, images, isHeader,
 *                 getPythonSource).
 *   - Does NOT:   touch other applets, the project model, or any
 *                 controller. Event wiring (edit / move / remove / right-
 *                 click / @-link nav) lives in src/cards.js Card.init()
 *                 against the element this module returns.
 *
 * Adding a new render kind:
 *   1. Create src/applets/card_view/<kind>_card.js
 *   2. Have it call register('<kind>', { renderContent, renderActions,
 *                                        renderKindPill, classes }) at
 *      import time.
 *   3. Add `import './<kind>_card.js';` here so the registration runs.
 *   4. Update selectKindKey in registry.js if the new kind needs a new
 *      dispatch rule.
 *   No edits to existing per-kind files.
 */
import { getRenderer, selectKindKey } from './registry.js';
import './header_card.js';
import './code_card.js';
import './markdown_card.js';
import './class_card.js';

/**
 * Build the complete DOM element for a card. Returns a freshly-created
 * <div class="card">; caller (Card.init) wires event handlers against
 * the returned element.
 */
export function renderCard(card) {
    const kindKey = selectKindKey(card);
    const renderer = getRenderer(kindKey) || getRenderer('markdown');

    const el = document.createElement('div');
    el.classList.add('card');
    for (const cls of (renderer.classes || [])) {
        el.classList.add(cls);
    }

    const contentHTML = renderer.renderContent(card);
    const actionsHTML = renderer.renderActions(card);
    const kindPill = renderer.renderKindPill(card);
    const promptHTML = renderPromptSection(card);

    el.innerHTML = `
        <div class="card_header">
            <div class="card_details">
                <h4>${card.title} ${kindPill}</h4>
                <p class="card_id">${card.id}</p>
            </div>
            <div class="card_actions">
                ${actionsHTML}
            </div>
        </div>
        ${promptHTML}
        <div class="card-content markdown-body">${contentHTML}</div>`;
    return el;
}

/**
 * Prompt block (above the response). Same shape for every kind: highlight
 * @-references, render any attached images. Returns '' if the card has no
 * prompt (e.g. headers).
 */
function renderPromptSection(card) {
    if (!card.prompt || card.prompt.trim() === '') return '';

    const highlightedPrompt = card.prompt.replace(/@([\w]+)/g, (_, name) =>
        `<span class="card-link-inline" data-link="${name}">@${name}</span>`);

    let imagesHTML = '';
    if (card.images && card.images.length > 0) {
        imagesHTML = `
            <div class="card-prompt-images">
                ${card.images.map(img => `
                    <img src="${img.data}" alt="${img.name}" class="card-prompt-image" />
                `).join('')}
            </div>
        `;
    }

    return `
        <div class="card-prompt-section">
            <span class="card-prompt-label">Prompt:</span>
            <div class="card-prompt-text">${highlightedPrompt}</div>
            ${imagesHTML}
        </div>
    `;
}

// Re-export the registry surface so callers (and future dynamic renderers)
// can introspect or extend it without reaching into ./registry directly.
export { register, getRenderer, selectKindKey } from './registry.js';
