#!/usr/bin/env node
/**
 * AST Contract Validator & CI Enforcement (Epic 3 / S-511).
 *
 * Enforces:
 * 1. JSON Schema validation against contracts/slate-node.schema.json & contracts/slate-flow.schema.json using Ajv.
 * 2. AST Contract validation using the Lezer Python parser:
 *    - Strict typing: all parameters must have explicit type annotations, and function signature must have a return type annotation.
 *    - JPL-60: <=60 total lines and <=60 executable lines per atomic function node (including normalized embedded newlines).
 *    - Single definition: code must define exactly one top-level function matching node.name.
 *    - Documentation: required non-empty intent and contract.
 * 3. Parity check: ensures 100% of defined functions in project Python files originate from and map to documented slate/nodes, slate/flows, or slate/library units.
 * 4. Drift check: verifies that compiled output matches committed disk output, resolving default outDir ('src').
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_OUT = path.join(ROOT, 'vscode-extension', 'out');

// Ensure vscode-extension/out is compiled if missing
if (!fs.existsSync(path.join(EXTENSION_OUT, 'slate_folder.js'))) {
    const { execSync } = require('child_process');
    execSync('npm --prefix vscode-extension run compile', {
        cwd: ROOT,
        stdio: 'inherit',
    });
}

const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

const nodeSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'slate-node.schema.json'), 'utf8'));
const flowSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'slate-flow.schema.json'), 'utf8'));

const validateNodeAjv = ajv.compile(nodeSchema);
const validateFlowAjv = ajv.compile(flowSchema);

const { parseModule } = require(path.join(EXTENSION_OUT, 'python_adapter.js'));
const { parseConfig, parseNode } = require(path.join(EXTENSION_OUT, 'slate_folder.js'));
const { parseFlow, unitSignature } = require(path.join(EXTENSION_OUT, 'flow.js'));
const { compilePython } = require(path.join(EXTENSION_OUT, 'compile', 'python.js'));

/**
 * Validate a node object against the formal JSON schema rules using Ajv.
 */
export function validateNodeSchema(data, sourceLabel = '<node>') {
    const errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, errors: [`${sourceLabel}: must be a JSON object`] };
    }

    const valid = validateNodeAjv(data);
    if (!valid && validateNodeAjv.errors) {
        for (const err of validateNodeAjv.errors) {
            const loc = err.instancePath ? err.instancePath : (err.params?.missingProperty ? `/${err.params.missingProperty}` : '');
            errors.push(`${sourceLabel}: ${loc} ${err.message}`.trim());
        }
    }

    // Additional semantic checks for whitespace-only strings and embedded newlines
    if (typeof data.intent === 'string' && data.intent.trim().length === 0) {
        errors.push(`${sourceLabel}: "intent" is required and must be a non-empty string`);
    }
    if (typeof data.contract === 'string' && data.contract.trim().length === 0) {
        errors.push(`${sourceLabel}: "contract" is required documentation and must be a non-empty string`);
    }
    if (Array.isArray(data.code)) {
        const flatLines = data.code.flatMap(line => typeof line === 'string' ? line.split(/\r?\n/) : [line]);
        if (flatLines.length > 60) {
            errors.push(`${sourceLabel}: code exceeds JPL-60 limit of 60 lines (${flatLines.length} lines > 60)`);
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate a flow object against the formal JSON schema rules using Ajv.
 */
export function validateFlowSchema(data, sourceLabel = '<flow>') {
    const errors = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, errors: [`${sourceLabel}: must be a JSON object`] };
    }

    const valid = validateFlowAjv(data);
    if (!valid && validateFlowAjv.errors) {
        for (const err of validateFlowAjv.errors) {
            const loc = err.instancePath ? err.instancePath : (err.params?.missingProperty ? `/${err.params.missingProperty}` : '');
            errors.push(`${sourceLabel}: ${loc} ${err.message}`.trim());
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate node AST via Lezer: strict typing, JPL-60 line limits, and definition match.
 */
export function validateNodeAst(node, relativePath = '<node>') {
    const errors = [];
    const warnings = [];

    const rawLines = Array.isArray(node.code) ? node.code : [];
    const codeLines = rawLines.flatMap(line => String(line).split(/\r?\n/));

    if (node.kind === 'prelude' || node.kind === 'epilogue') {
        // Module state: validate Python syntax
        const codeText = `${codeLines.join('\n')}\n`;
        const parsed = parseModule(codeText, relativePath);
        if (!parsed.valid) {
            errors.push(`${relativePath}: Python syntax error in module ${node.kind}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
        }
        return { valid: errors.length === 0, errors, warnings, unit: null };
    }

    const codeText = `${codeLines.join('\n')}\n`;
    const parsed = parseModule(codeText, relativePath, node.name);

    if (!parsed.valid) {
        errors.push(`${relativePath}: Python syntax error: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
        return { valid: false, errors, warnings, unit: null };
    }

    const topLevel = parsed.units.filter(unit => unit.parentId === null);
    if (topLevel.length !== 1 || topLevel[0].name !== node.name) {
        errors.push(`${relativePath}: code must contain exactly one definition named "${node.name}" (found ${topLevel.length}: ${topLevel.map(u => u.name).join(', ') || 'none'})`);
        return { valid: false, errors, warnings, unit: null };
    }

    const definition = topLevel[0];

    if (definition.kind !== 'function') {
        errors.push(`${relativePath}: atomic unit "${node.name}" must be a function, but is "${definition.kind}"`);
    }

    // Strict typing: all parameters must have explicit type annotations (no self/cls exemption for top-level functions)
    if (definition.params) {
        for (const param of definition.params) {
            if (!param.annotation || param.annotation.trim().length === 0) {
                errors.push(`${relativePath}: [STRICT_TYPING] Parameter "${param.name}" in function "${node.name}" is missing a type annotation`);
            }
        }
    }

    // Strict typing: function must declare a return type annotation (-> ReturnType)
    if (!definition.returnAnnotation || definition.returnAnnotation.trim().length === 0) {
        errors.push(`${relativePath}: [STRICT_TYPING] Function "${node.name}" is missing a return type annotation (-> ReturnType)`);
    }

    // JPL-60: <=60 total lines and <=60 executable lines (normalized for embedded newlines)
    if (codeLines.length > 60) {
        errors.push(`${relativePath}: [JPL-60] Function "${node.name}" exceeds 60 total lines (${codeLines.length} lines > 60). Split or refactor into stubs and a flow.`);
    }

    const executableLines = codeLines.filter(line => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#');
    });

    if (executableLines.length > 60) {
        errors.push(`${relativePath}: [JPL-60] Function "${node.name}" exceeds 60 executable lines (${executableLines.length} lines > 60). Split or refactor into stubs and a flow.`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        unit: definition,
    };
}

/**
 * Read and index all library documents and files, matching SlateFolderHost.readLibrary.
 * Recursively descends into directory entries in config.library.
 */
export function readProjectLibrary(projectDir, config) {
    const documents = [];
    const libraryFiles = new Set();
    const libraryUnits = new Set();

    function visit(relativePath) {
        const fullPath = path.join(projectDir, relativePath);
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
                if (entry.isDirectory()) {
                    visit(`${relativePath.replace(/\/+$/, '')}/${entry.name}`);
                } else if (entry.isFile() && entry.name.endsWith('.py')) {
                    visit(`${relativePath.replace(/\/+$/, '')}/${entry.name}`);
                }
            }
            return;
        }
        if (!relativePath.endsWith('.py')) return;
        const normalizedRel = path.normalize(relativePath).replace(/\\/g, '/');
        libraryFiles.add(normalizedRel);
        const text = fs.readFileSync(fullPath, 'utf8');
        const parsed = parseModule(text, relativePath);
        documents.push({
            path: normalizedRel,
            units: parsed.units,
            valid: parsed.valid,
        });
        for (const unit of parsed.units) {
            libraryUnits.add(unit.name);
        }
    }

    for (const entry of config.library ?? []) {
        visit(entry.replace(/\\/g, '/'));
    }

    return { documents, libraryFiles, libraryUnits };
}

/**
 * Scan project Python files to ensure 100% of defined functions originate from
 * and map to a documented slate/nodes/, slate/flows/, or slate/library unit.
 * Fails with a clear diagnostic if an undocumented rogue function exists.
 */
export function checkProjectParity(projectDir) {
    const errors = [];
    const configPath = path.join(projectDir, 'slate', 'slate.json');
    if (!fs.existsSync(configPath)) {
        return { valid: true, errors: [], documentedUnits: [], scannedFiles: [] };
    }

    const config = parseConfig(fs.readFileSync(configPath, 'utf8'));
    const nodesDir = path.join(projectDir, 'slate', 'nodes');
    const flowsDir = path.join(projectDir, 'slate', 'flows');

    const documentedUnits = new Set();

    // Collect documented node names
    if (fs.existsSync(nodesDir)) {
        const nodeFiles = fs.readdirSync(nodesDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\\/g, '/'));

        for (const file of nodeFiles) {
            try {
                const node = parseNode(fs.readFileSync(path.join(nodesDir, file), 'utf8'));
                documentedUnits.add(node.name);
                const nodeId = file.slice(0, -'.json'.length);
                documentedUnits.add(nodeId);
            } catch {
                // Node parsing errors handled in schema/ast check
            }
        }
    }

    // Collect documented flow names
    if (fs.existsSync(flowsDir)) {
        const flowFiles = fs.readdirSync(flowsDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\\/g, '/'));

        for (const file of flowFiles) {
            try {
                const flow = parseFlow(fs.readFileSync(path.join(flowsDir, file), 'utf8'));
                documentedUnits.add(flow.name);
                const flowId = file.slice(0, -'.json'.length);
                documentedUnits.add(flowId);
            } catch {
                // Flow parsing errors handled elsewhere
            }
        }
    }

    // Collect library files and units
    const { libraryFiles, libraryUnits } = readProjectLibrary(projectDir, config);
    for (const unitName of libraryUnits) {
        documentedUnits.add(unitName);
    }

    // Identify project Python files to scan
    const scannedFiles = [];

    function collectPyFiles(dir, relativeTo = '') {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryRel = relativeTo ? `${relativeTo}/${entry.name}` : entry.name;
            const normalizedRel = path.normalize(entryRel).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (['tests', 'vendor', '__pycache__', '.venv', 'venv', 'env', 'node_modules'].includes(entry.name)) {
                    continue;
                }
                collectPyFiles(path.join(dir, entry.name), entryRel);
            } else if (entry.isFile() && entry.name.endsWith('.py')) {
                if (entry.name.startsWith('test_') || entry.name.endsWith('_test.py')) {
                    continue;
                }
                if (libraryFiles.has(normalizedRel)) {
                    continue;
                }
                scannedFiles.push({ fullPath: path.join(dir, entry.name), relativePath: entryRel });
            }
        }
    }

    // Resolve outDir (defaults to 'src' when compile.outDir is omitted, matching compileSlateFolder)
    if (config.compile) {
        const outDirRel = (config.compile.outDir ?? 'src').replace(/\\/g, '/').replace(/\/+$/, '');
        const outDir = path.resolve(projectDir, outDirRel);
        collectPyFiles(outDir, outDirRel);
    }

    for (const { fullPath, relativePath } of scannedFiles) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const parsed = parseModule(content, relativePath);
        if (!parsed.valid) continue;

        for (const unit of parsed.units) {
            if (unit.parentId === null && unit.kind === 'function') {
                if (!documentedUnits.has(unit.name)) {
                    errors.push(
                        `[ROGUE_FUNCTION] Undocumented function "${unit.name}" found at ${relativePath}:${unit.ranges.name.start.line + 1}. Every defined function must originate from and map to a documented slate/nodes/ or slate/flows/ unit.`
                    );
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        documentedUnits: [...documentedUnits],
        scannedFiles: scannedFiles.map(s => s.relativePath),
    };
}

/**
 * Verify that compiled output matches committed disk output.
 * Resolves default outDir ('src') when compile.outDir is omitted (matching compileSlateFolder).
 */
export function checkProjectDrift(projectDir) {
    const errors = [];
    const filesChecked = [];
    const configPath = path.join(projectDir, 'slate', 'slate.json');
    if (!fs.existsSync(configPath)) {
        return { valid: true, errors: [], filesChecked };
    }

    const config = parseConfig(fs.readFileSync(configPath, 'utf8'));
    if (!config.compile) {
        return { valid: true, errors: [], filesChecked };
    }

    const outDirRel = (config.compile.outDir ?? 'src').replace(/\\/g, '/').replace(/\/+$/, '');
    const outDir = path.resolve(projectDir, outDirRel);

    if (!fs.existsSync(outDir)) {
        errors.push(`[COMPILE_DRIFT] Output directory "${outDirRel}" does not exist in project ${projectDir}. Compiled output must be generated and committed.`);
        return { valid: false, errors, filesChecked };
    }

    const nodesDir = path.join(projectDir, 'slate', 'nodes');
    const flowsDir = path.join(projectDir, 'slate', 'flows');

    const nodes = new Map();
    if (fs.existsSync(nodesDir)) {
        const files = fs.readdirSync(nodesDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\\/g, '/'));
        for (const file of files) {
            const nodeId = file.slice(0, -'.json'.length);
            nodes.set(nodeId, parseNode(fs.readFileSync(path.join(nodesDir, file), 'utf8')));
        }
    }

    const flows = new Map();
    if (fs.existsSync(flowsDir)) {
        const files = fs.readdirSync(flowsDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\\/g, '/'));
        for (const file of files) {
            const flowId = file.slice(0, -'.json'.length);
            flows.set(flowId, parseFlow(fs.readFileSync(path.join(flowsDir, file), 'utf8')));
        }
    }

    const library = new Map();
    const { documents } = readProjectLibrary(projectDir, config);
    for (const doc of documents) {
        for (const unit of doc.units.filter(item => item.parentId === null)) {
            library.set(`lib:${doc.path}:${unit.name}`, unitSignature(unit, doc.units));
        }
    }

    const result = compilePython(nodes, config, flows, library);
    for (const diag of result.diagnostics) {
        if (diag.severity === 'error') {
            errors.push(`Compile error in ${projectDir}: ${diag.message}`);
        }
    }

    const compiledRelativePaths = new Set();
    for (const [relPath, expectedText] of result.files) {
        compiledRelativePaths.add(relPath);
        const diskFile = path.join(outDir, relPath);
        filesChecked.push(relPath);

        if (!fs.existsSync(diskFile)) {
            errors.push(`[COMPILE_DRIFT] Missing compiled file on disk: ${path.join(outDirRel, relPath)}`);
            continue;
        }

        const diskContent = fs.readFileSync(diskFile, 'utf8').replace(/\r\n/g, '\n');
        const expectedNormalized = expectedText.replace(/\r\n/g, '\n');

        if (diskContent !== expectedNormalized) {
            errors.push(`[COMPILE_DRIFT] File content mismatch in ${path.join(outDirRel, relPath)}. Compile output does not match committed disk file.`);
        }
    }

    // Check for unexpected extra .py files in outDir
    if (fs.existsSync(outDir)) {
        const diskFiles = fs.readdirSync(outDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.py'))
            .map(name => name.replace(/\\/g, '/'));

        for (const diskRel of diskFiles) {
            if (!compiledRelativePaths.has(diskRel)) {
                errors.push(`[COMPILE_DRIFT] Unexpected extra file in ${outDirRel}: ${diskRel}`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        filesChecked,
    };
}

/**
 * Validate all nodes and flows in a project directory.
 */
export function validateProjectContracts(projectDir) {
    const errors = [];
    const warnings = [];
    let nodesCount = 0;
    let flowsCount = 0;

    const nodesDir = path.join(projectDir, 'slate', 'nodes');
    if (fs.existsSync(nodesDir)) {
        const nodeFiles = fs.readdirSync(nodesDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\\/g, '/'));

        for (const file of nodeFiles) {
            nodesCount++;
            const fullPath = path.join(nodesDir, file);
            let raw;
            try {
                raw = fs.readFileSync(fullPath, 'utf8');
            } catch (err) {
                errors.push(`${file}: read failure: ${err.message}`);
                continue;
            }

            let data;
            try {
                data = JSON.parse(raw);
            } catch (err) {
                errors.push(`${file}: not valid JSON: ${err.message}`);
                continue;
            }

            const schemaRes = validateNodeSchema(data, file);
            if (!schemaRes.valid) {
                errors.push(...schemaRes.errors);
            }

            const astRes = validateNodeAst(data, file);
            if (!astRes.valid) {
                errors.push(...astRes.errors);
            }
            warnings.push(...astRes.warnings);
        }
    }

    const flowsDir = path.join(projectDir, 'slate', 'flows');
    if (fs.existsSync(flowsDir)) {
        const flowFiles = fs.readdirSync(flowsDir, { recursive: true })
            .map(String)
            .filter(name => name.endsWith('.json'))
            .map(name => name.replace(/\\/g, '/'));

        for (const file of flowFiles) {
            flowsCount++;
            const fullPath = path.join(flowsDir, file);
            let data;
            try {
                data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            } catch (err) {
                errors.push(`${file}: not valid JSON: ${err.message}`);
                continue;
            }

            const schemaRes = validateFlowSchema(data, file);
            if (!schemaRes.valid) {
                errors.push(...schemaRes.errors);
            }
        }
    }

    const parityRes = checkProjectParity(projectDir);
    if (!parityRes.valid) {
        errors.push(...parityRes.errors);
    }

    const driftRes = checkProjectDrift(projectDir);
    if (!driftRes.valid) {
        errors.push(...driftRes.errors);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        nodesCount,
        flowsCount,
    };
}

/**
 * Top-level runner discovering all projects in the workspace.
 */
export function verifyAll(projectDirs = []) {
    let targets = projectDirs;
    if (targets.length === 0) {
        // Auto-discover Slate projects (active workspace projects)
        const candidates = [
            path.join(ROOT, 'examples', 'flow_demo'),
            path.join(ROOT, 'examples', 'llama_demo'),
        ];
        targets = candidates.filter(dir => fs.existsSync(path.join(dir, 'slate', 'slate.json')));
    }

    const allErrors = [];
    const allWarnings = [];
    let totalNodes = 0;
    let totalFlows = 0;

    for (const target of targets) {
        const res = validateProjectContracts(target);
        totalNodes += res.nodesCount;
        totalFlows += res.flowsCount;
        allErrors.push(...res.errors);
        allWarnings.push(...res.warnings);
    }

    return {
        success: allErrors.length === 0,
        errors: allErrors,
        warnings: allWarnings,
        stats: {
            projectsCount: targets.length,
            nodesCount: totalNodes,
            flowsCount: totalFlows,
        },
    };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const args = process.argv.slice(2);
    const result = verifyAll(args);

    if (result.warnings.length > 0) {
        console.warn(`\nWarnings (${result.warnings.length}):`);
        for (const w of result.warnings) {
            console.warn(`  ! ${w}`);
        }
    }

    if (!result.success) {
        console.error(`\nContract & CI Verification FAILED (${result.errors.length} violations):`);
        for (const err of result.errors) {
            console.error(`  ✗ ${err}`);
        }
        process.exit(1);
    }

    console.log(`\n✓ Contract & CI Verification PASSED:`);
    console.log(`  - Projects verified: ${result.stats.projectsCount}`);
    console.log(`  - Nodes verified: ${result.stats.nodesCount} (schema, typing, JPL-60 <=60 lines)`);
    console.log(`  - Flows verified: ${result.stats.flowsCount}`);
    console.log(`  - Parity: 100% of defined functions originate from documented units`);
    console.log(`  - Drift: zero compilation drift detected\n`);
    process.exit(0);
}
