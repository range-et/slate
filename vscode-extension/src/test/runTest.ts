import * as path from 'path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const fixture = path.resolve(extensionDevelopmentPath, 'test-fixtures/electron');
    await runTests({
        version: '1.139.0',
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [fixture, '--disable-workspace-trust', '--skip-welcome'],
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
