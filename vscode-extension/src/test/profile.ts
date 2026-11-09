import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Each native run starts with its own settings and editor layout. */
export async function withTestProfile<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'slate-extension-test-'));
    try {
        await mkdir(join(directory, 'User'));
        await writeFile(join(directory, 'User', 'settings.json'), JSON.stringify({
            'workbench.startupEditor': 'none',
            'window.restoreWindows': 'none',
            'chat.disableAIFeatures': true,
        }));
        return await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
