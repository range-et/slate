import { sourceCoveragePlugin } from './scripts/coverage-vite-plugin.mjs';
import { defineConfig } from 'vitest/config';

// Harness unit tests. Legacy notebook tests use legacy/vitest.config.js.
export default defineConfig({
    // VS Code is supplied by the real Extension Host, never by a browser shim.
    // Marking it external also lets coverage transform unexecuted host modules.
    plugins: [sourceCoveragePlugin(), {
        name: 'vscode-host-boundary',
        resolveId(id) {
            if (id === 'vscode') return { id, external: true };
        },
    }],
    test: {
        environment: 'jsdom',
        include: ['test/**/*.test.{js,ts,tsx}'],
        globals: false,
        setupFiles: process.env.SLATE_SOURCE_COVERAGE ? ['test/support/source-coverage.ts'] : [],
    },
});
