#!/usr/bin/env node
/**
 * AST Contract Validator & 4-Pillar CI Enforcement (Epic 3 / S-511).
 *
 * Delegates to compiled `vscode-extension/out/ci_verifier.js` so CLI, MCP (`slate_verify_ci`),
 * Vitest, and GitHub Actions (`slate-ci.yml`) share one source of truth.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_OUT = path.join(ROOT, 'vscode-extension', 'out');

if (!fs.existsSync(path.join(EXTENSION_OUT, 'ci_verifier.js'))) {
    execSync('npm --prefix vscode-extension run compile', {
        cwd: ROOT,
        stdio: 'inherit',
    });
}

const ciVerifier = require(path.join(EXTENSION_OUT, 'ci_verifier.js'));

export const {
    resolveCiConfig,
    validateNodeSchema,
    validateFlowSchema,
    validateNodeAst,
    readProjectLibrary,
    checkProjectParity,
    checkProjectDrift,
    checkProjectTests,
    verifyProjectCi,
    validateProjectContracts,
    verifyAll,
    formatCiReportText,
} = ciVerifier;

function splitRoots(raw) {
    return raw.split(',').map(part => part.trim()).filter(Boolean);
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    const rawArgs = process.argv.slice(2);
    const projectDirs = [];
    const options = {};
    let jsonMode = false;

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg === '--json') {
            jsonMode = true;
        } else if (arg === '--require-tests') {
            options.requireTests = true;
        } else if (arg === '--no-require-tests') {
            options.requireTests = false;
        } else if (arg === '--src-roots' && rawArgs[i + 1]) {
            options.srcRoots = splitRoots(rawArgs[++i]);
        } else if (arg.startsWith('--src-roots=')) {
            options.srcRoots = splitRoots(arg.slice('--src-roots='.length));
        } else if (arg === '--test-roots' && rawArgs[i + 1]) {
            options.testRoots = splitRoots(rawArgs[++i]);
        } else if (arg.startsWith('--test-roots=')) {
            options.testRoots = splitRoots(arg.slice('--test-roots='.length));
        } else if (!arg.startsWith('-')) {
            projectDirs.push(path.resolve(arg));
        } else {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        }
    }

    const result = verifyAll(projectDirs, options);

    if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
    }

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
