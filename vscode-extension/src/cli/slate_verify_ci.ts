#!/usr/bin/env node
import * as path from 'path';

import { formatCiReportText, verifyProjectCi, type CiVerifyOptions } from '../ci_verifier';

export interface CliIo {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const HELP_TEXT = [
    'Usage: slate-verify-ci [options] [workspaceDir]',
    '',
    'Run Slate 4-Pillar CI verification (Schema, Stub, Code parity/drift, Test coverage).',
    '',
    'Options:',
    '  --workspace <dir>     Project root containing slate/slate.json (default: cwd)',
    '  --src-roots <a,b>     Comma-separated source roots for parity checks',
    '  --test-roots <a,b>    Comma-separated test roots for test coverage checks',
    '  --require-tests       Fail if any atomic node lacks cases, check, or testRoots coverage',
    '  --no-require-tests    Warn instead of failing on missing test coverage',
    '  --json                Emit structured JSON report',
    '  -h, --help            Show help',
].join('\n');

function splitRootsFlag(value: string): string[] {
    return value.split(',').map(part => part.trim()).filter(Boolean);
}

/** Run the standalone 4-pillar Slate CI gate CLI and return process exit code (`0` or `1`). */
export function runSlateVerifyCiCli(
    argv: readonly string[],
    io: CliIo = { stdout: s => console.log(s), stderr: s => console.error(s) },
): number {
    let workspaceDir = process.cwd();
    let jsonMode = false;
    const options: CiVerifyOptions = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            io.stdout(HELP_TEXT);
            return 0;
        }
        if (arg === '--json') {
            jsonMode = true;
            continue;
        }
        if (arg === '--require-tests') {
            options.requireTests = true;
            continue;
        }
        if (arg === '--no-require-tests') {
            options.requireTests = false;
            continue;
        }
        if (arg === '--workspace' && argv[i + 1]) {
            workspaceDir = path.resolve(argv[++i]);
            continue;
        }
        if (arg.startsWith('--workspace=')) {
            workspaceDir = path.resolve(arg.slice('--workspace='.length));
            continue;
        }
        if (arg === '--src-roots' && argv[i + 1]) {
            options.srcRoots = splitRootsFlag(argv[++i]);
            continue;
        }
        if (arg.startsWith('--src-roots=')) {
            options.srcRoots = splitRootsFlag(arg.slice('--src-roots='.length));
            continue;
        }
        if (arg === '--test-roots' && argv[i + 1]) {
            options.testRoots = splitRootsFlag(argv[++i]);
            continue;
        }
        if (arg.startsWith('--test-roots=')) {
            options.testRoots = splitRootsFlag(arg.slice('--test-roots='.length));
            continue;
        }
        if (!arg.startsWith('-')) {
            workspaceDir = path.resolve(arg);
            continue;
        }
        io.stderr(`Unknown option: ${arg}`);
        io.stderr(HELP_TEXT);
        return 1;
    }

    try {
        const report = verifyProjectCi(workspaceDir, options);
        if (jsonMode) {
            io.stdout(JSON.stringify(report, null, 2));
        } else if (report.valid) {
            io.stdout(formatCiReportText(report));
        } else {
            io.stderr(formatCiReportText(report));
        }
        return report.valid ? 0 : 1;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (jsonMode) {
            io.stdout(JSON.stringify({ valid: false, errors: [message] }, null, 2));
        } else {
            io.stderr(`Slate 4-Pillar CI Verification error: ${message}`);
        }
        return 1;
    }
}

const isDirectCli = process.argv[1] && path.basename(process.argv[1]).startsWith('slate_verify_ci');
if (isDirectCli) {
    process.exitCode = runSlateVerifyCiCli(process.argv.slice(2));
}
