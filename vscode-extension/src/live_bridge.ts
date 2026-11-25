import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LiveBridgeRecord {
    version: 1;
    workspaceRoot: string;
    port: number;
    pid: number;
    token: string;
    createdAt: number;
}

export const LIVE_BRIDGE_TOKEN_HEADER = 'x-slate-bridge-token';

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
    let resolved: string;
    try {
        resolved = fs.realpathSync(workspaceRoot);
    } catch {
        resolved = path.resolve(workspaceRoot);
    }
    const stripped = resolved.replace(/[\\/]+$/, '') || resolved;
    return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}

export function getBridgeRuntimeDir(overrideDir?: string): string {
    if (overrideDir && overrideDir.trim()) {
        return path.resolve(overrideDir);
    }
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'slate', 'bridges');
    }
    if (process.env.XDG_RUNTIME_DIR) {
        return path.join(process.env.XDG_RUNTIME_DIR, 'slate', 'bridges');
    }
    const home = os.homedir();
    if (home) {
        return path.join(home, '.cache', 'slate', 'bridges');
    }
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    return path.join(os.tmpdir(), `slate-bridges-${uid}`);
}

export function resolveBridgeFilePath(workspaceRoot: string, overrideDir?: string): string {
    const canonical = canonicalizeWorkspaceRoot(workspaceRoot);
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    return path.join(getBridgeRuntimeDir(overrideDir), `bridge-${hash}.json`);
}

export function generateBridgeToken(): string {
    return randomBytes(32).toString('hex');
}

export function verifyBridgeToken(headerValue: string | string[] | undefined, expectedToken: string): boolean {
    if (typeof headerValue !== 'string' || !expectedToken) return false;
    const gotBuf = Buffer.from(headerValue, 'utf8');
    const expBuf = Buffer.from(expectedToken, 'utf8');
    if (gotBuf.length !== expBuf.length) return false;
    return timingSafeEqual(gotBuf, expBuf);
}

function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code !== 'ESRCH';
    }
}

function parseValidatedRecord(rawText: string, expectedCanonicalRoot: string): LiveBridgeRecord | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.version !== 1) return null;
    if (rec.workspaceRoot !== expectedCanonicalRoot) return null;
    if (typeof rec.port !== 'number' || !Number.isInteger(rec.port) || rec.port < 1024 || rec.port > 65535) {
        return null;
    }
    if (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid) || rec.pid <= 0) {
        return null;
    }
    if (typeof rec.token !== 'string' || !/^[a-f0-9]{64}$/.test(rec.token)) {
        return null;
    }
    if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) {
        return null;
    }
    if (!isPidAlive(rec.pid)) {
        return null;
    }
    return {
        version: 1,
        workspaceRoot: rec.workspaceRoot,
        port: rec.port,
        pid: rec.pid,
        token: rec.token,
        createdAt: rec.createdAt,
    };
}

export async function writeLiveBridgeRecord(
    workspaceRoot: string,
    port: number,
    token: string,
    overrideDir?: string,
): Promise<string> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error(`Invalid live bridge port: ${port}`);
    }
    if (!/^[a-f0-9]{64}$/.test(token)) {
        throw new Error('Invalid live bridge token format.');
    }
    const filePath = resolveBridgeFilePath(workspaceRoot, overrideDir);
    const dirPath = path.dirname(filePath);
    await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
    const dirStat = await fs.promises.lstat(dirPath);
    if (!dirStat.isDirectory()) {
        throw new Error(`Bridge directory "${dirPath}" is not a real directory.`);
    }
    if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) {
        throw new Error(`Bridge directory "${dirPath}" is not owned by the current user.`);
    }

    const record: LiveBridgeRecord = {
        version: 1,
        workspaceRoot: canonicalizeWorkspaceRoot(workspaceRoot),
        port,
        pid: process.pid,
        token,
        createdAt: Date.now(),
    };
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmpPath, filePath);
    return filePath;
}

export async function readValidatedLiveBridgeRecord(
    workspaceRoot: string,
    overrideDir?: string,
): Promise<LiveBridgeRecord | null> {
    const filePath = resolveBridgeFilePath(workspaceRoot, overrideDir);
    const dirPath = path.dirname(filePath);
    try {
        const dirStat = await fs.promises.lstat(dirPath);
        if (!dirStat.isDirectory()) return null;
        if (typeof process.getuid === 'function') {
            if (dirStat.uid !== process.getuid()) return null;
            if ((dirStat.mode & 0o022) !== 0) return null;
        }
        const fileStat = await fs.promises.lstat(filePath);
        if (!fileStat.isFile()) return null;
        if (typeof process.getuid === 'function') {
            if (fileStat.uid !== process.getuid()) return null;
            if ((fileStat.mode & 0o077) !== 0) return null;
        }
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return parseValidatedRecord(raw, canonicalizeWorkspaceRoot(workspaceRoot));
    } catch {
        return null;
    }
}

export async function removeLiveBridgeRecord(
    workspaceRoot: string,
    expectedToken: string,
    overrideDir?: string,
): Promise<void> {
    const filePath = resolveBridgeFilePath(workspaceRoot, overrideDir);
    try {
        const fileStat = await fs.promises.lstat(filePath);
        if (!fileStat.isFile()) return;
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as { token?: unknown };
        if (parsed?.token === expectedToken) {
            await fs.promises.unlink(filePath);
        }
    } catch {
        // Ignore cleanup failures if file does not exist or changed ownership.
    }
}
