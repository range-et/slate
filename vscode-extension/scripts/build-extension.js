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

// The extension host bundle plus the standalone stdio MCP server. The server is bundled so the
// installed VSIX (which excludes node_modules) can launch out/mcp/slate_mcp_server.js directly.
Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js' }),
    esbuild.build({ ...common, entryPoints: ['src/mcp/slate_mcp_server.ts'], outfile: 'out/mcp/slate_mcp_server.js' }),
]).catch(error => { console.error(error); process.exitCode = 1; });
