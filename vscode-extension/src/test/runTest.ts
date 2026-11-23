import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

import { runBoundedElectronProcess } from './electron_runner';
import { withTestProfile } from './profile';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const fixture = path.resolve(extensionDevelopmentPath, 'test-fixtures/electron');
    const executablePath = await downloadAndUnzipVSCode('1.139.0');
    await withTestProfile(async profile => {
        const resultFile = path.join(profile, 'extension-host-result.json');
        await runBoundedElectronProcess({
            executablePath,
            resultFile,
            args: [
                fixture,
                '--disable-workspace-trust',
                '--skip-welcome',
                '--skip-release-notes',
                '--no-sandbox',
                '--disable-gpu-sandbox',
                '--disable-updates',
                '--no-cached-data',
                `--user-data-dir=${profile}`,
                `--extensions-dir=${path.join(profile, 'extensions')}`,
                `--extensionTestsPath=${extensionTestsPath}`,
                `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
            ],
        });
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
