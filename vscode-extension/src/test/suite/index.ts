import * as path from 'path';
import * as fs from 'fs';

import Mocha from 'mocha';

function writeTestResult(payload: { status: 'passed' | 'failed'; failures: number; error?: string }): void {
    const resultFile = process.env.SLATE_TEST_RESULT_FILE;
    if (!resultFile) return;
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    const tempFile = `${resultFile}.tmp.${process.pid}`;
    fs.writeFileSync(tempFile, JSON.stringify(payload), 'utf8');
    fs.renameSync(tempFile, resultFile);
}

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });
    mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
    mocha.addFile(path.resolve(__dirname, 'mcp.test.js'));
    mocha.addFile(path.resolve(__dirname, 'persistence.test.js'));
    mocha.addFile(path.resolve(__dirname, 'project.test.js'));
    return new Promise((resolve, reject) => {
        mocha.run(failures => {
            try {
                if (process.env.SLATE_SOURCE_COVERAGE) {
                    const coverage = (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__;
                    if (!coverage) throw new Error('Extension Host source instrumentation is missing');
                    const directory = path.resolve(__dirname, '../../../../coverage/native');
                    fs.mkdirSync(directory, { recursive: true });
                    fs.writeFileSync(path.join(directory, 'extension-host.json'), JSON.stringify(coverage));
                }
                writeTestResult({
                    status: failures > 0 ? 'failed' : 'passed',
                    failures,
                });
                failures > 0 ? reject(new Error(`${failures} test(s) failed.`)) : resolve();
            } catch (error) {
                try {
                    writeTestResult({
                        status: 'failed',
                        failures: Math.max(1, failures),
                        error: error instanceof Error ? error.message : String(error),
                    });
                } catch {
                    // Preserve original runner failure when result file cannot be written.
                }
                reject(error);
            }
        });
    });
}
