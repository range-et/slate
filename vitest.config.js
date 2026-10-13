import { defineConfig } from 'vitest/config';

// Harness unit tests. Legacy notebook tests use legacy/vitest.config.js.
export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['test/**/*.test.{js,ts,tsx}'],
        globals: false,
    },
});
