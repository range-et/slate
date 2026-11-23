#!/usr/bin/env node
/**
 * Repeatable Two-Tier Spec-to-Forge Benchmark Runner (Issue #53).
 *
 * Exercises the full Frontier Architect -> Tier 2 Forge -> Deterministic Compile -> pytest loop
 * in an isolated temporary workspace using SlateMcpServer directly, and measures:
 *   - Frontier spec tokens vs MCP reply tokens
 *   - Frontier implementation LOC (must remain 0) vs Tier 2 forged code + check LOC
 *   - Single-batch completion rate, wave count, retries, duplicate imports, and pytest results.
 *
 * Usage:
 *   node scripts/benchmark-offload.mjs --spec benchmarks/specs/sci_calc.json --provider fake
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_OUT = path.join(ROOT, 'vscode-extension', 'out');

function ensureExtensionBuilt() {
    const required = [
        path.join(EXTENSION_OUT, 'mcp', 'slate_mcp_server.js'),
        path.join(EXTENSION_OUT, 'port', 'python_importer.js'),
        path.join(EXTENSION_OUT, 'verification_runner.js'),
        path.join(EXTENSION_OUT, 'slate_folder.js'),
    ];
    if (required.some(p => !fs.existsSync(p))) {
        execSync('npm --prefix vscode-extension run compile', { cwd: ROOT, stdio: 'inherit' });
    }
}

function resolveExecutablePython(verificationRunnerModule) {
    const candidates = [
        verificationRunnerModule.resolvePythonPath(),
        ...(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']),
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            execFileSync(candidate, ['--version'], { stdio: 'pipe', timeout: 5000 });
            return candidate;
        } catch {
            // Try next candidate
        }
    }
    throw new Error('Could not locate a working Python interpreter for benchmark pytest verification.');
}

async function startFakeOpenAiServer(fakeResponses) {
    const responsesByLeaf = new Map();
    for (const [id, content] of Object.entries(fakeResponses)) {
        responsesByLeaf.set(id, content);
        const leaf = id.split('/').pop();
        if (leaf && !responsesByLeaf.has(leaf)) {
            responsesByLeaf.set(leaf, content);
        }
    }

    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/health')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'fake-tier2-coder' }] }));
            return;
        }
        if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
            res.writeHead(404).end();
            return;
        }
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(raw);
                const userMsg = [...(payload.messages ?? [])]
                    .reverse()
                    .find(m => m && m.role === 'user')?.content ?? '';
                const stubMatch = String(userMsg).match(/###\s*Target\s+stub:\s*([^\r\n]+)/i);
                const stubTarget = stubMatch ? stubMatch[1].trim() : '';
                let reply = responsesByLeaf.get(stubTarget);
                if (!reply && stubTarget) {
                    const leaf = stubTarget.split(/[./]/).pop();
                    if (leaf) reply = responsesByLeaf.get(leaf);
                }
                if (!reply) {
                    res.writeHead(500, { 'content-type': 'text/plain' });
                    res.end(`No fake response configured for stub target "${stubTarget}"`);
                    return;
                }
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
                res.end('data: [DONE]\n\n');
            } catch (error) {
                res.writeHead(400, { 'content-type': 'text/plain' });
                res.end(error instanceof Error ? error.message : String(error));
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
        throw new Error('Fake OpenAI server failed to bind port.');
    }
    return {
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((resolve, reject) => {
            server.close(err => (err ? reject(err) : resolve()));
            server.closeAllConnections();
        }),
    };
}

/**
 * Count duplicate or mid-file top-level Python imports in compiled module files.
 */
export function inspectCompiledPythonImports(filesMap) {
    let duplicateImportCount = 0;
    const details = [];
    for (const [relPath, content] of Object.entries(filesMap)) {
        const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
        const seenTopLevelImports = new Set();
        let seenTopLevelDef = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^(?:async\s+)?def\s+|^class\s+/.test(line)) {
                seenTopLevelDef = true;
                continue;
            }
            if (/^(?:import\s+\S|from\s+\S+\s+import\s+)/.test(line)) {
                const normalized = line.trim();
                if (seenTopLevelImports.has(normalized)) {
                    duplicateImportCount++;
                    details.push(`${relPath}:${i + 1} duplicate "${normalized}"`);
                } else if (seenTopLevelDef) {
                    duplicateImportCount++;
                    details.push(`${relPath}:${i + 1} mid-file import "${normalized}"`);
                }
                seenTopLevelImports.add(normalized);
            }
        }
    }
    return { duplicateImportCount, details };
}

function countLines(text) {
    const trimmed = String(text ?? '').replace(/\r\n?/g, '\n');
    if (!trimmed.trim()) return 0;
    const lines = trimmed.split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length;
}

/**
 * Execute a full declarative spec-to-forge benchmark using real Slate MCP tools.
 */
export async function runBenchmarkOffload(options = {}) {
    ensureExtensionBuilt();
    const { SlateMcpServer } = require(path.join(EXTENSION_OUT, 'mcp', 'slate_mcp_server.js'));
    const { portPythonProject } = require(path.join(EXTENSION_OUT, 'port', 'python_importer.js'));
    const { parseNode, serializeConfig, serializeNode } = require(path.join(EXTENSION_OUT, 'slate_folder.js'));
    const verificationRunner = require(path.join(EXTENSION_OUT, 'verification_runner.js'));

    const specPath = path.resolve(ROOT, options.specPath ?? 'benchmarks/specs/sci_calc.json');
    const spec = JSON.parse(await fsp.readFile(specPath, 'utf8'));
    const provider = options.provider ?? 'fake';
    const concurrency = options.concurrency ?? 3;
    const maxRevisions = options.maxRevisions ?? 3;
    const verboseForge = options.verboseForge === true;
    const pythonPath = options.pythonPath ?? resolveExecutablePython(verificationRunner);

    const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), `slate-bench-${spec.name}-`));
    let fakeServer;
    let mcpServer;

    try {
        const slateDir = path.join(workspaceDir, 'slate');
        await fsp.mkdir(path.join(slateDir, 'nodes'), { recursive: true });
        await fsp.mkdir(path.join(slateDir, 'flows'), { recursive: true });

        if (spec.baseExample) {
            const baseDir = path.resolve(ROOT, spec.baseExample);
            const sourceFiles = new Map();
            const entries = fs.readdirSync(baseDir, { recursive: true });
            for (const entry of entries) {
                const rel = String(entry).replace(/\\/g, '/');
                if (rel.endsWith('.py') && !rel.split('/').some(seg => seg === 'tests' || seg === '__pycache__')) {
                    sourceFiles.set(rel, await fsp.readFile(path.join(baseDir, rel), 'utf8'));
                }
            }
            const { nodes } = portPythonProject(sourceFiles);
            for (const [id, node] of nodes.entries()) {
                const dest = path.join(slateDir, 'nodes', `${id}.json`);
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                await fsp.writeFile(dest, serializeNode(node), 'utf8');
            }
        }

        let endpoint = options.endpoint;
        let model = options.model;
        let apiKeyEnv = options.apiKeyEnv;
        let effectiveProvider = provider;

        if (provider === 'fake') {
            if (!spec.fakeResponses || typeof spec.fakeResponses !== 'object') {
                throw new Error(`Spec "${specPath}" does not include "fakeResponses" for --provider fake.`);
            }
            fakeServer = await startFakeOpenAiServer(spec.fakeResponses);
            endpoint = fakeServer.url;
            model = model ?? 'fake-tier2-coder';
            effectiveProvider = 'openai-compatible';
        }

        const outDir = spec.outDir ?? 'src';
        const config = {
            slate: 3,
            name: spec.name,
            language: 'python',
            compile: { outDir },
        };
        await fsp.writeFile(path.join(slateDir, 'slate.json'), serializeConfig(config), 'utf8');

        mcpServer = new SlateMcpServer(workspaceDir);

        let frontierSpecChars = 0;
        let mcpReplyChars = 0;
        let forgeReplyChars = 0;
        let frontierImplLoc = 0;

        const callMcp = async (toolName, toolArgs, isForgeCall = false) => {
            frontierSpecChars += JSON.stringify({ tool: toolName, arguments: toolArgs }).length;
            const res = await mcpServer.callTool(toolName, toolArgs);
            const replyText = res.content?.[0]?.text ?? '';
            mcpReplyChars += replyText.length;
            if (isForgeCall) forgeReplyChars += replyText.length;
            if (res.isError) {
                throw new Error(`MCP tool ${toolName} failed: ${replyText}`);
            }
            return JSON.parse(replyText);
        };

        // 1. Define stubs via slate_define_stub
        const stubsPayload = Array.isArray(spec.stubs) ? spec.stubs : [];
        for (const stub of stubsPayload) {
            if (typeof stub.body === 'string' && !/^\s*(?:pass|\.\.\.|raise\s+NotImplementedError)\s*$/.test(stub.body)) {
                frontierImplLoc += countLines(stub.body);
            }
        }
        await callMcp('slate_define_stub', { stubs: stubsPayload });

        // 2. Single-batch Tier 2 forge via slate_forge_batch
        const batchArgs = {
            allStubs: true,
            concurrency,
            maxRevisions,
            verify: true,
            write: true,
            ...(verboseForge ? { verbose: true } : {}),
            ...(effectiveProvider ? { provider: effectiveProvider } : {}),
            ...(endpoint ? { endpoint } : {}),
            ...(model ? { model } : {}),
            ...(apiKeyEnv ? { apiKeyEnv } : {}),
        };
        const forgeResult = await callMcp('slate_forge_batch', batchArgs, true);

        // 3. Wire flows declaratively via slate_wire_flow
        const flowResults = [];
        for (const flowSpec of spec.flows ?? []) {
            const wired = await callMcp('slate_wire_flow', flowSpec);
            flowResults.push(wired);
        }

        // 4. Deterministically compile via slate_compile
        const compileResult = await callMcp('slate_compile', { outDir });

        // 5. Measure forged node LOC on disk
        let tier2ForgedCodeLoc = 0;
        let tier2ForgedCheckLoc = 0;
        for (const stub of stubsPayload) {
            const nodePath = path.join(slateDir, 'nodes', `${stub.name}.json`);
            try {
                const parsed = parseNode(await fsp.readFile(nodePath, 'utf8'));
                tier2ForgedCodeLoc += parsed.code.length;
                tier2ForgedCheckLoc += (parsed.check ?? []).length;
            } catch {
                // ignore unreadable node
            }
        }

        // 6. Inspect compiled Python LOC + duplicate/mid-file imports
        const compiledOutAbs = path.join(workspaceDir, outDir);
        const compiledFilesContent = {};
        let compiledPythonLoc = 0;
        if (Array.isArray(compileResult.writtenFiles)) {
            for (const rel of compileResult.writtenFiles) {
                if (!String(rel).endsWith('.py')) continue;
                const text = await fsp.readFile(path.join(compiledOutAbs, rel), 'utf8');
                compiledFilesContent[rel] = text;
                compiledPythonLoc += countLines(text);
            }
        }
        const { duplicateImportCount, details: duplicateImportDetails } = inspectCompiledPythonImports(compiledFilesContent);

        // 7. Run compiled integration pytest suites
        let pytestPassed = false;
        let pytestOutput = '';
        if (compileResult.ok && forgeResult.forgedCount === stubsPayload.length) {
            const pytestTargets = [];
            if (Array.isArray(spec.pytestSource) && spec.pytestSource.length > 0) {
                const testPath = path.join(workspaceDir, `test_${spec.name}_compiled.py`);
                await fsp.writeFile(testPath, `${spec.pytestSource.join('\n')}\n`, 'utf8');
                pytestTargets.push(testPath);
            }
            const pytestEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
            if (spec.basePytestDir && spec.basePytestEnvVar) {
                pytestTargets.push(path.resolve(ROOT, spec.basePytestDir));
                pytestEnv[spec.basePytestEnvVar] = compiledOutAbs;
            }
            if (pytestTargets.length > 0) {
                try {
                    const out = execFileSync(pythonPath, ['-m', 'pytest', '--import-mode=importlib', '-q', ...pytestTargets], {
                        cwd: workspaceDir,
                        env: pytestEnv,
                        encoding: 'utf8',
                        timeout: 30000,
                    });
                    pytestOutput = out.trim();
                    pytestPassed = true;
                } catch (err) {
                    pytestOutput = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
                    pytestPassed = false;
                }
            } else {
                pytestPassed = true;
            }
        }

        const scorecard = {
            ok: Boolean(
                forgeResult.ok
                && forgeResult.forgedCount === stubsPayload.length
                && compileResult.ok
                && pytestPassed,
            ),
            spec: spec.name,
            provider,
            model: forgeResult.model ?? model ?? null,
            totalStubs: stubsPayload.length,
            batchesRun: 1,
            waves: forgeResult.waves ?? 1,
            forgedCount: forgeResult.forgedCount ?? 0,
            failedCount: forgeResult.failedCount ?? 0,
            skippedCount: forgeResult.skippedCount ?? 0,
            totalAttempts: forgeResult.totalAttempts ?? 0,
            forgeDurationMs: forgeResult.totalDurationMs ?? 0,
            frontierSpecChars,
            frontierSpecEstTokens: Math.ceil(frontierSpecChars / 4),
            frontierImplLoc,
            mcpReplyChars,
            mcpReplyEstTokens: Math.ceil(mcpReplyChars / 4),
            forgeReplyChars,
            forgeReplyEstTokens: Math.ceil(forgeReplyChars / 4),
            tier2ForgedCodeLoc,
            tier2ForgedCheckLoc,
            compiledPythonLoc,
            compileOk: Boolean(compileResult.ok),
            duplicateImportCount,
            duplicateImportDetails,
            flowsWired: flowResults.length,
            pytestPassed,
            pytestOutput,
            results: forgeResult.results,
            workspaceDir: options.keepTemp ? workspaceDir : undefined,
        };
        return scorecard;
    } finally {
        mcpServer?.close();
        if (fakeServer) {
            await fakeServer.close();
        }
        if (!options.keepTemp) {
            await fsp.rm(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }
}

function parseCliArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--spec' && argv[i + 1]) opts.specPath = argv[++i];
        else if (arg === '--provider' && argv[i + 1]) opts.provider = argv[++i];
        else if (arg === '--endpoint' && argv[i + 1]) opts.endpoint = argv[++i];
        else if (arg === '--model' && argv[i + 1]) opts.model = argv[++i];
        else if (arg === '--api-key-env' && argv[i + 1]) opts.apiKeyEnv = argv[++i];
        else if (arg === '--concurrency' && argv[i + 1]) opts.concurrency = Number(argv[++i]);
        else if (arg === '--max-revisions' && argv[i + 1]) opts.maxRevisions = Number(argv[++i]);
        else if (arg === '--out-json' && argv[i + 1]) opts.outJson = argv[++i];
        else if (arg === '--python' && argv[i + 1]) opts.pythonPath = argv[++i];
        else if (arg === '--verbose-forge') opts.verboseForge = true;
        else if (arg === '--keep-temp') opts.keepTemp = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node scripts/benchmark-offload.mjs [--spec PATH] [--provider fake|openrouter|llama.cpp|ollama|openai-compatible] [--endpoint URL] [--model ID] [--api-key-env VAR] [--concurrency N] [--max-revisions N] [--out-json PATH] [--verbose-forge] [--keep-temp]');
            process.exit(0);
        }
    }
    return opts;
}

function formatScorecardMarkdown(s) {
    const lines = [
        `## Slate Offload Benchmark: ${s.spec} (${s.provider}${s.model ? ` / ${s.model}` : ''})`,
        '',
        `| Metric | Value |`,
        `|---|---|`,
        `| Status | ${s.ok ? 'PASS' : 'FAIL'} |`,
        `| Forged / Total Stubs | ${s.forgedCount} / ${s.totalStubs} (failed=${s.failedCount}, skipped=${s.skippedCount}) |`,
        `| Batches / Waves / Attempts | ${s.batchesRun} / ${s.waves} / ${s.totalAttempts} |`,
        `| Forge Wall Time | ${s.forgeDurationMs} ms |`,
        `| Frontier Implementation LOC | ${s.frontierImplLoc} |`,
        `| Tier 2 Forged LOC (code + check) | ${s.tier2ForgedCodeLoc} + ${s.tier2ForgedCheckLoc} = ${s.tier2ForgedCodeLoc + s.tier2ForgedCheckLoc} |`,
        `| Compiled Python LOC | ${s.compiledPythonLoc} |`,
        `| Duplicate / Mid-file Imports | ${s.duplicateImportCount} |`,
        `| Frontier Spec Payload (est. tokens) | ${s.frontierSpecEstTokens} (${s.frontierSpecChars} chars) |`,
        `| Total MCP Reply (est. tokens) | ${s.mcpReplyEstTokens} (${s.mcpReplyChars} chars) |`,
        `| Forge Reply Only (est. tokens) | ${s.forgeReplyEstTokens} (${s.forgeReplyChars} chars) |`,
        `| Compiled pytest | ${s.pytestPassed ? 'PASS' : 'FAIL'} |`,
    ];
    if (s.pytestOutput) {
        lines.push('', `Pytest summary: \`${s.pytestOutput}\``);
    }
    if (!s.ok && Array.isArray(s.results)) {
        const failed = s.results.filter(r => r.status !== 'forged');
        if (failed.length > 0) {
            lines.push('', 'Non-forged nodes:');
            for (const f of failed) {
                lines.push(`- ${f.nodeId} (${f.status}): ${f.reason ?? 'unknown'}`);
            }
        }
    }
    return lines.join('\n');
}

const isDirectCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectCli) {
    const cliOpts = parseCliArgs(process.argv.slice(2));
    const scorecard = await runBenchmarkOffload(cliOpts);
    if (cliOpts.outJson) {
        const outPath = path.resolve(process.cwd(), cliOpts.outJson);
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.writeFile(outPath, `${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
    }
    console.log(formatScorecardMarkdown(scorecard));
    process.exitCode = scorecard.ok ? 0 : 1;
}
