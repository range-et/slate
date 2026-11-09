import { mutationBridgePlugin } from './scripts/mutation-vite-plugin.mjs';
import { sourceCoveragePlugin } from './scripts/coverage-vite-plugin.mjs';
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Builds the harness webview served by the VS Code extension from dist/.
// The frozen browser notebook has its own config in legacy/vite.config.js.
export default defineConfig({
    root: 'src',
    plugins: [sourceCoveragePlugin(), mutationBridgePlugin()],
    publicDir: '../design-tokens/build',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: { harness: fileURLToPath(new URL('./src/harness.html', import.meta.url)) },
        },
    },
})
