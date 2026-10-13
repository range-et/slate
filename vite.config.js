import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the harness webview served by the VS Code extension from dist/.
// The frozen browser notebook has its own config in legacy/vite.config.js.
export default defineConfig({
    root: 'src',
    publicDir: '../design-tokens/build',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: { harness: resolve(__dirname, 'src/harness.html') },
        },
    },
})
