import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Frozen legacy browser notebook. GitHub Pages builds this until the harness
// replaces it. BASE_URL is '/slate/' on Pages and '/' locally.
export default defineConfig({
    root: resolve(here, 'src'),
    base: process.env.BASE_URL || '/',
    publicDir: resolve(here, '../design-tokens/build'),
    build: {
        outDir: resolve(here, 'dist'),
        emptyOutDir: true,
    },
})
