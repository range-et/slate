import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    canonicalizeWorkspaceRoot,
    generateBridgeToken,
    LIVE_BRIDGE_TOKEN_HEADER,
    readValidatedLiveBridgeRecord,
    removeLiveBridgeRecord,
    resolveBridgeFilePath,
    verifyBridgeToken,
    writeLiveBridgeRecord,
} from '../vscode-extension/src/live_bridge';

describe('live bridge runtime storage and token validation (P0-2)', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        for (const dir of tempDirs.splice(0)) {
            await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('stores bridge records in a user-private runtime dir outside workspace/.slate and validates tokens + PIDs', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-live-bridge-test-'));
        tempDirs.push(tmp);
        const workspaceRoot = path.join(tmp, 'workspace');
        const bridgeDir = path.join(tmp, 'runtime-bridges');
        await fs.mkdir(workspaceRoot, { recursive: true });

        expect(LIVE_BRIDGE_TOKEN_HEADER).toBe('x-slate-bridge-token');

        // Default bridge file path must live outside workspace/.slate
        const defaultBridgePath = resolveBridgeFilePath(workspaceRoot);
        expect(path.resolve(defaultBridgePath).startsWith(path.resolve(workspaceRoot) + path.sep)).toBe(false);
        expect(defaultBridgePath).not.toContain('.slate');

        const token = generateBridgeToken();
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(verifyBridgeToken(token, token)).toBe(true);
        expect(verifyBridgeToken(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), token)).toBe(false);
        expect(verifyBridgeToken('short', token)).toBe(false);
        expect(verifyBridgeToken([token], token)).toBe(false);
        expect(verifyBridgeToken(undefined, token)).toBe(false);

        const writtenPath = await writeLiveBridgeRecord(workspaceRoot, 43123, token, bridgeDir);
        expect(writtenPath).toBe(resolveBridgeFilePath(workspaceRoot, bridgeDir));
        await expect(fs.stat(path.join(workspaceRoot, '.slate', 'live_bridge.json'))).rejects.toThrow();

        const loaded = await readValidatedLiveBridgeRecord(workspaceRoot, bridgeDir);
        expect(loaded).not.toBeNull();
        expect(loaded?.port).toBe(43123);
        expect(loaded?.token).toBe(token);
        expect(loaded?.pid).toBe(process.pid);
        expect(loaded?.workspaceRoot).toBe(canonicalizeWorkspaceRoot(workspaceRoot));

        // Wrong workspace root must fail lookup/validation
        const otherWorkspace = path.join(tmp, 'other-workspace');
        await fs.mkdir(otherWorkspace, { recursive: true });
        expect(await readValidatedLiveBridgeRecord(otherWorkspace, bridgeDir)).toBeNull();

        // Tampered workspaceRoot or dead PID on disk must fail validation
        const rawRec = JSON.parse(await fs.readFile(writtenPath, 'utf8'));
        await fs.writeFile(writtenPath, JSON.stringify({ ...rawRec, workspaceRoot: canonicalizeWorkspaceRoot(otherWorkspace) }), 'utf8');
        expect(await readValidatedLiveBridgeRecord(workspaceRoot, bridgeDir)).toBeNull();

        await fs.writeFile(writtenPath, JSON.stringify({ ...rawRec, port: 80 }), 'utf8');
        expect(await readValidatedLiveBridgeRecord(workspaceRoot, bridgeDir)).toBeNull();

        await fs.writeFile(writtenPath, JSON.stringify({ ...rawRec, pid: 99999999 }), 'utf8');
        expect(await readValidatedLiveBridgeRecord(workspaceRoot, bridgeDir)).toBeNull();

        // Restore valid record and verify removeLiveBridgeRecord checks expectedToken
        await writeLiveBridgeRecord(workspaceRoot, 43123, token, bridgeDir);
        await removeLiveBridgeRecord(workspaceRoot, 'wrong-token'.padEnd(64, '0'), bridgeDir);
        expect(await readValidatedLiveBridgeRecord(workspaceRoot, bridgeDir)).not.toBeNull();

        await removeLiveBridgeRecord(workspaceRoot, token, bridgeDir);
        expect(await readValidatedLiveBridgeRecord(workspaceRoot, bridgeDir)).toBeNull();
    });

    it('rejects out-of-range ports and invalid tokens on write', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-live-bridge-err-'));
        tempDirs.push(tmp);
        const workspaceRoot = path.join(tmp, 'workspace');
        const bridgeDir = path.join(tmp, 'runtime-bridges');
        await fs.mkdir(workspaceRoot, { recursive: true });

        await expect(writeLiveBridgeRecord(workspaceRoot, 80, generateBridgeToken(), bridgeDir)).rejects.toThrow(/Invalid live bridge port/);
        await expect(writeLiveBridgeRecord(workspaceRoot, 45000, 'not-a-hex-token', bridgeDir)).rejects.toThrow(/Invalid live bridge token/);
    });
});
