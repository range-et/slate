/**
 * One-off smoke test for v0.2 phase 1 (issues #1–#4). Will be replaced by
 * proper vitest coverage in issue #29. Run with: `node scripts/verify-phase1.mjs`.
 *
 * Stubs the minimum DOM that Modal / Card construction touches so we can
 * exercise pure data-layer behaviors from node.
 */

// Minimal DOM stubs — enough for Modal's constructor and Card.create() to not crash.
// We never render anything; we just need the imports to load.
const noopElement = () => ({
    innerHTML: '',
    style: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: () => {},
    getAttribute: () => null,
    remove: () => {},
});
globalThis.document = {
    getElementById: () => noopElement(),
    createElement: () => noopElement(),
    body: noopElement(),
};

const { default: Doc } = await import('../src/doc.js');
const { default: Card, CARD_KIND_HEADER, CARD_KIND_BODY, HEADER_CARD_TITLE } = await import('../src/cards.js');

let passed = 0;
let failed = 0;
function check(label, ok) {
    if (ok) { console.log(`  ✓ ${label}`); passed++; }
    else    { console.log(`  ✗ ${label}`); failed++; }
}

// ─── #2: Auto-create header card on Doc.init() ────────────────────────────
console.log('\n#2 Auto-create header card on Doc.init()');
{
    const doc = new Doc('foo');
    doc.init();
    check('doc.cards.length === 1 after init', doc.cards.length === 1);
    check('first card is the header', doc.cards[0].kind === CARD_KIND_HEADER);
    check('header card title is reserved', doc.cards[0].title === HEADER_CARD_TITLE);
    check('header card has a uuid', !!doc.cards[0].id);
}

// ─── #4: Forbid duplicate headers; pin to position 0 ──────────────────────
console.log('\n#4 Forbid duplicate header cards & enforce position 0');
{
    const doc = new Doc('bar');
    doc.init();
    const second = new Card('also_header', '', null, null, '', [], 'markdown', CARD_KIND_HEADER);
    second.id = 'fake-id-2';
    const result = doc.addCard(second);
    check('addCard rejects a second header', result === false);
    check('still exactly one card after rejection', doc.cards.length === 1);

    // Add some body cards; header must remain at index 0.
    const body1 = new Card('first_body', '', null, null, '', [], 'markdown', CARD_KIND_BODY);
    body1.id = 'b1';
    const body2 = new Card('second_body', '', null, null, '', [], 'markdown', CARD_KIND_BODY);
    body2.id = 'b2';
    doc.addCard(body1);
    doc.addCard(body2);
    check('header still at index 0 after adding bodies', doc.cards[0].kind === CARD_KIND_HEADER);
    check('body cards appended after header', doc.cards[1].id === 'b1' && doc.cards[2].id === 'b2');
}

// ─── #2 cont: removeCard refuses header ───────────────────────────────────
console.log('\n#2 cont. Header card cannot be removed via removeCard()');
{
    const doc = new Doc('baz');
    doc.init();
    const headerId = doc.cards[0].id;
    const result = doc.removeCard(headerId);
    check('removeCard returns false on header', result === false);
    check('header card still present', doc.cards.find(c => c.id === headerId) !== undefined);

    // Body card removal still works.
    const body = new Card('removable', '', null, null, '', [], 'markdown', CARD_KIND_BODY);
    body.id = 'removable-id';
    doc.addCard(body);
    check('body card removal returns true', doc.removeCard('removable-id') === true);
}

// ─── #1: kind round-trips through JSON ────────────────────────────────────
console.log('\n#1 `kind` round-trips through toJSON/fromJSON');
{
    const doc = new Doc('round_trip');
    doc.init();
    const body = new Card('a_body', 'body content', null, null, 'a prompt', [], 'markdown', CARD_KIND_BODY);
    body.id = 'body-id';
    doc.addCard(body);

    const json = doc.toJSON();
    check('header serialized with kind=header', json.cards[0].kind === CARD_KIND_HEADER);
    check('body serialized with kind=body', json.cards[1].kind === CARD_KIND_BODY);

    const restored = Doc.fromJSON(json);
    check('header round-tripped', restored.cards[0].kind === CARD_KIND_HEADER);
    check('body round-tripped', restored.cards[1].kind === CARD_KIND_BODY);
    check('exactly one header after round-trip (no synth duplicate)', restored.cards.filter(c => c.kind === CARD_KIND_HEADER).length === 1);
}

// ─── #1 + #2: legacy doc without header gets one synthesized on load ──────
console.log('\n#1/#2 Legacy projects (no kind, no header) get header synthesized on load');
{
    const legacyJson = {
        id: 'legacy-doc-id',
        title: 'legacy_doc',
        summary: null,
        destination: '',
        cards: [
            { id: 'old-card-1', title: 'old_card_1', content: 'foo', prompt: '', images: [], links: [], cardType: 'markdown' },
            { id: 'old-card-2', title: 'old_card_2', content: 'bar', prompt: '', images: [], links: [], cardType: 'code' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        cardCount: 2
    };
    const restored = Doc.fromJSON(legacyJson);
    check('legacy doc has header synthesized at index 0', restored.cards[0].kind === CARD_KIND_HEADER);
    check('legacy cards default to kind=body', restored.cards[1].kind === CARD_KIND_BODY && restored.cards[2].kind === CARD_KIND_BODY);
    check('cardType preserved through migration', restored.cards[1].cardType === 'markdown' && restored.cards[2].cardType === 'code');
    check('legacy card count + 1 header = 3 cards', restored.cards.length === 3);

    // Re-serialize and re-load: header should persist (no double-synth).
    const reJson = restored.toJSON();
    const reRestored = Doc.fromJSON(reJson);
    check('save + reload preserves the synthesized header (no duplicate)', reRestored.cards.filter(c => c.kind === CARD_KIND_HEADER).length === 1);
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
