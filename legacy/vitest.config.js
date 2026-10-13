import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The legacy model layer touches the DOM (Doc/Card), so it runs under jsdom.
export default defineConfig({
    test: {
        root: dirname(fileURLToPath(import.meta.url)),
        environment: 'jsdom',
        include: ['test/**/*.test.js'],
    },
});
