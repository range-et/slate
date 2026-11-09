import * as path from 'path';
import * as fs from 'fs';

import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });
    mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
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
                failures > 0 ? reject(new Error(`${failures} test(s) failed.`)) : resolve();
            } catch (error) { reject(error); }
        });
    });
}
