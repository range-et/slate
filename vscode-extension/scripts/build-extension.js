const esbuild = require('esbuild');
const fs = require('node:fs');
const { instrumentSource } = require('../../scripts/source-instrumentation.cjs');

esbuild.build({
    plugins: process.env.SLATE_SOURCE_COVERAGE ? [{
        name: 'slate-source-coverage',
        setup(build) {
            build.onLoad({ filter: /\.ts$/ }, args => {
                const sourcePath = args.path.replace(/\\/g, '/');
                if (!sourcePath.includes('/vscode-extension/src/') || sourcePath.includes('/src/test/')) return;
                const result = instrumentSource(fs.readFileSync(args.path, 'utf8'), args.path);
                return { contents: result.code, loader: 'ts' };
            });
        },
    }] : [],
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
}).catch(error => { console.error(error); process.exitCode = 1; });
