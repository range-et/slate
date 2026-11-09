import { expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTestProfile } from '../vscode-extension/src/test/profile';

it('isolates native editor settings and cleans up after a successful run', async () => {
    let directory = '';
    const result = await withTestProfile(async profile => {
        directory = profile;
        expect(JSON.parse(await readFile(join(profile, 'User/settings.json'), 'utf8'))).toEqual({
            'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'chat.disableAIFeatures': true,
        });
        await writeFile(join(profile, 'state'), 'test-owned state');
        return 42;
    });
    expect(result).toBe(42);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves the test failure while removing the temporary profile', async () => {
    let directory = '';
    const error = new Error('native suite failed');
    await expect(withTestProfile(async profile => {
        directory = profile;
        throw error;
    })).rejects.toBe(error);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('uses independent directories for concurrent invocations', async () => {
    const directories = await Promise.all([withTestProfile(async dir => dir), withTestProfile(async dir => dir)]);
    expect(directories[0]).not.toBe(directories[1]);
});
