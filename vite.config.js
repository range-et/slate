import { defineConfig } from 'vite'

export default defineConfig({
    root: 'src',
    // Copies design-tokens/build/ into dist/ so monad.js ships with the bundle
    publicDir: '../design-tokens/build',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
})