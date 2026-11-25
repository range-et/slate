import * as fs from 'fs';
import * as path from 'path';
import { normalizeCompileOutputPath, RESERVED_OUTPUT_ROOTS } from './language_types';

function normalizeComparePath(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Normalize an output path key for case-collision detection on case-insensitive filesystems. */
export function caseCollisionKey(relPath: string): string {
    return process.platform === 'win32' || process.platform === 'darwin'
        ? relPath.toLowerCase()
        : relPath;
}

/**
 * Resolve the real filesystem path of `targetPath` even when leaf directories or files
 * do not yet exist, by resolving the deepest existing ancestor via `fs.promises.realpath`
 * and re-attaching remaining segments.
 */
export async function resolveRealPathWithAncestor(targetPath: string): Promise<string> {
    let current = path.resolve(targetPath);
    const tail: string[] = [];
    while (true) {
        try {
            const realBase = await fs.promises.realpath(current);
            return tail.length > 0 ? path.join(realBase, ...tail.reverse()) : realBase;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return path.resolve(targetPath);
            }
            tail.push(path.basename(current));
            current = parent;
        }
    }
}

/** Check whether `candidatePath` stays inside `basePath` (case-insensitive on win32). */
export function isPathInsideBase(basePath: string, candidatePath: string, allowEqual = false): boolean {
    const rel = path.relative(normalizeComparePath(basePath), normalizeComparePath(candidatePath));
    if (!rel) return allowEqual;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Assert that `targetPath` resolves inside `baseRealDir` without escaping through symlinks or `..`. */
export async function assertPathInsideRealDir(
    baseRealDir: string,
    targetPath: string,
    allowEqual = false,
): Promise<string> {
    const realTarget = await resolveRealPathWithAncestor(targetPath);
    if (!isPathInsideBase(baseRealDir, realTarget, allowEqual)) {
        throw new Error(`Path traversal rejected: "${targetPath}" escapes "${baseRealDir}".`);
    }
    return realTarget;
}

export interface SafeCompileOutDirResult {
    normalizedOutDir: string;
    resolvedRoot: string;
    resolvedOut: string;
    realRoot: string;
    realOut: string;
}

/**
 * Validate `rawOutDir` as a relative compile output directory inside `workspaceRoot`
 * and outside reserved project roots (`slate`, `.slate`, `.git`, `.vscode`), including
 * case-insensitive variants and symlinked paths.
 */
export async function assertSafeCompileOutDir(
    workspaceRoot: string,
    rawOutDir: string,
    options?: { checkRealpath?: boolean },
): Promise<SafeCompileOutDirResult> {
    if (typeof rawOutDir !== 'string' || /[\0\r\n]/.test(rawOutDir)) {
        throw new Error(`Unsafe compile output directory "${String(rawOutDir)}": must stay inside workspace and outside "slate/".`);
    }
    const trimmed = rawOutDir.trim();
    const normalizedOutDir = normalizeCompileOutputPath(trimmed);
    const firstSegment = normalizedOutDir?.split('/')[0]?.toLowerCase() ?? '';
    if (!normalizedOutDir || RESERVED_OUTPUT_ROOTS.has(firstSegment)) {
        throw new Error(`Unsafe compile output directory "${rawOutDir}": must be a relative folder outside "slate/".`);
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedOut = path.resolve(resolvedRoot, normalizedOutDir);
    if (!isPathInsideBase(resolvedRoot, resolvedOut, false)) {
        throw new Error(`Unsafe compile output directory "${rawOutDir}": escapes workspace root.`);
    }

    if (options?.checkRealpath === false) {
        return {
            normalizedOutDir,
            resolvedRoot,
            resolvedOut,
            realRoot: resolvedRoot,
            realOut: resolvedOut,
        };
    }

    const realRoot = await resolveRealPathWithAncestor(resolvedRoot);
    const realOut = await resolveRealPathWithAncestor(resolvedOut);
    if (!isPathInsideBase(realRoot, realOut, false)) {
        throw new Error(`Unsafe compile output directory "${rawOutDir}": resolves outside workspace root.`);
    }
    const realRel = path.relative(normalizeComparePath(realRoot), normalizeComparePath(realOut)).replace(/\\/g, '/');
    const realFirstSegment = realRel.split('/')[0]?.toLowerCase() ?? '';
    if (!realFirstSegment || RESERVED_OUTPUT_ROOTS.has(realFirstSegment)) {
        throw new Error(`Unsafe compile output directory "${rawOutDir}": resolves into reserved directory "${realFirstSegment}".`);
    }

    return {
        normalizedOutDir,
        resolvedRoot,
        resolvedOut,
        realRoot,
        realOut,
    };
}
