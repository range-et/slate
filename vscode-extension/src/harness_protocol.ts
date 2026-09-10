export const WORKER_PROTOCOL_VERSION = 1 as const;

export interface SourcePosition {
    line: number;
    character: number;
}

export interface SourceRange {
    start: SourcePosition;
    end: SourcePosition;
}

export type UnitKind =
    | 'class'
    | 'nested_class'
    | 'function'
    | 'method'
    | 'nested_function';

export interface ParsedUnit {
    id: string;
    identity: 'durable' | 'provisional';
    kind: UnitKind;
    name: string;
    qualifiedName: string;
    parentId: string | null;
    ranges: {
        name: SourceRange;
        declaration: SourceRange;
        annotation: SourceRange | null;
        full: SourceRange;
    };
    annotation: Record<string, unknown> | null;
    decorators: string[];
    async?: boolean;
    parameters?: string;
    returnAnnotation?: string | null;
    signature?: string;
}

export interface ParseModuleResult {
    path: string;
    sourceHash: `sha256:${string}`;
    valid: boolean;
    units: ParsedUnit[];
    diagnostics: Array<{
        code: string;
        message: string;
        range: SourceRange;
    }>;
}

export interface HarnessDocument extends ParseModuleResult {
    id: string;
    version: number | null;
    stale: boolean;
}

export interface HarnessSnapshot {
    revision: number;
    projectName: string;
    documents: HarnessDocument[];
    contextEdges?: HarnessGraphEdge[];
    layout?: Record<string, { x: number; y: number }>;
}

export interface HarnessGraphEdge {
    sourceId: string;
    targetId: string;
    kind: 'context' | 'inferred';
}

export interface SourceProposal {
    baseSourceHash: `sha256:${string}`;
    proposedSourceHash: `sha256:${string}`;
    edits: Array<{ range: SourceRange; newText: string }>;
    proposedSource: string;
    parsed: ParseModuleResult;
}

export type WorkerMethod =
    | 'health'
    | 'parseModule'
    | 'adoptUnit'
    | 'updateAnnotation'
    | 'insertStub'
    | 'replaceUnit'
    | 'shutdown';

export interface WorkerRequest {
    id: string | number;
    protocolVersion: typeof WORKER_PROTOCOL_VERSION;
    method: WorkerMethod;
    params: Record<string, unknown>;
}

export type WorkerResponse<T = unknown> =
    | { id: string | number | null; ok: true; result: T }
    | {
        id: string | number | null;
        ok: false;
        error: { code: string; message: string };
    };

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkerResponse(value: unknown): WorkerResponse {
    if (!isObject(value) || typeof value.ok !== 'boolean') {
        throw new Error('Worker response must be an object with an ok boolean.');
    }
    const id = value.id;
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
        throw new Error('Worker response id must be a string, number, or null.');
    }
    if (value.ok) {
        if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
            throw new Error('Successful worker response is missing result.');
        }
        return { id, ok: true, result: value.result };
    }
    if (!isObject(value.error)
        || typeof value.error.code !== 'string'
        || typeof value.error.message !== 'string') {
        throw new Error('Failed worker response has an invalid error.');
    }
    return {
        id,
        ok: false,
        error: { code: value.error.code, message: value.error.message },
    };
}
