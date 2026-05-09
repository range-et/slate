import { defineConfig } from 'vite'

// BASE_URL controls the public path the bundle is served from.
// - Local dev / VS Code webview: '/' (default)
// - GitHub Pages: '/slate/' (set by .github/workflows/pages.yml via env)
// - Custom domain on GH Pages later: set BASE_URL='/' in the workflow.
const base = process.env.BASE_URL || '/'

export default defineConfig({
    root: 'src',
    base,
    // Copies design-tokens/build/ into dist/ so monad.js ships with the bundle
    publicDir: '../design-tokens/build',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
})