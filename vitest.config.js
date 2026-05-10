/**
 * Vitest config for Slate's headless test suite.
 *
 * Uses the `jsdom` environment so the DOM-coupled corners of the
 * codebase (Doc.getFlattenedContent uses document.createElement; Card
 * holds an `innerHTML` element ref; etc.) work without a browser.
 *
 * Tests live in `test/` and target the pure / near-pure layer:
 *   - src/code_compile.js          — pure
 *   - src/controllers/chat_ctl.js  — pure helpers
 *   - src/doc.js / project.js      — model layer (light DOM use)
 *
 * Run with:  npm run test
 *            npm run test -- --watch
 *            npm run test -- test/calculator.test.js
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['test/**/*.test.js'],
        // The src/ tree imports config_loader.js, which the prebuild step
        // creates as a stub. Make sure the stub exists before vitest runs
        // by reusing the existing ensure-config script through the npm
        // script wrapper. (We don't add a hook here — npm test handles it.)
        globals: false,
    },
});
