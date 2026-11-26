const esbuild = require('esbuild');
const fs = require('node:fs');
const { instrumentSource } = require('../../scripts/source-instrumentation.cjs');

const common = {
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
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
};

// The extension host bundle, standalone stdio MCP server, and standalone CI verifier CLI.
// Bundled so installed VSIX or external CI checkouts run without node_modules.
Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js' }),
    esbuild.build({ ...common, entryPoints: ['src/mcp/slate_mcp_server.ts'], outfile: 'out/mcp/slate_mcp_server.js' }),
    esbuild.build({ ...common, entryPoints: ['src/cli/slate_verify_ci.ts'], outfile: 'out/cli/slate_verify_ci.js' }),
]).catch(error => { console.error(error); process.exitCode = 1; });
