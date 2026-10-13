/**
 * Round-trip fixed-point tests (issues #53, #54b).
 *
 * Compile a `.slate.json` doc → annotated `.py` source → rehydrate that
 * source back into a fresh clone of the project → compile again. The
 * second compile output MUST equal the first byte-for-byte. If it
 * doesn't, the round-trip is lossy and the user's `.py` edits won't
 * survive a save / re-open cycle.
 *
 * These tests guard the **only** invariant the future "round-trip
 * code edits" feature (#53) and the future "load-folder/import-repo"
 * work (#56) actually depend on. Every example we ship MUST pass.
 */
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRoundtrip } from '../scripts/slate_roundtrip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

describe('compile → rehydrate → compile fixed point', () => {
    it.each([
        ['examples/calculator/calculator.slate.json'],
        ['examples/tic_tac_toe/tic_tac_toe.slate.json'],
    ])('%s round-trips identically per doc', (relpath) => {
        const results = runRoundtrip(join(REPO, relpath));
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
            expect(
                r.ok,
                `${relpath} :: doc "${r.doc}" — ${r.reason || 'ok'}`
            ).toBe(true);
        }
    });
});
