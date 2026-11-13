import { mutationBridgePlugin } from './scripts/mutation-vite-plugin.mjs';
import { sourceCoveragePlugin } from './scripts/coverage-vite-plugin.mjs';
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Builds the landing page and the harness webview served by the VS Code extension and web demo from dist/.
export default defineConfig({
    root: 'src',
    base: './',
    plugins: [sourceCoveragePlugin(), mutationBridgePlugin()],
    publicDir: '../design-tokens/build',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: fileURLToPath(new URL('./src/index.html', import.meta.url)),
                harness: fileURLToPath(new URL('./src/harness.html', import.meta.url)),
            },
        },
    },
})
