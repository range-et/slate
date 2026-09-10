export interface SourcePosition {
    line: number;
    character: number;
}

export interface SourceRange {
    start: SourcePosition;
    end: SourcePosition;
}

export interface HarnessUnit {
    id: string;
    identity: 'durable' | 'provisional';
    kind: 'class' | 'nested_class' | 'function' | 'method' | 'nested_function';
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
    signature?: string;
}

export interface HarnessDocument {
    id: string;
    path: string;
    valid: boolean;
    stale: boolean;
    sourceHash: string;
    version: number | null;
    units: HarnessUnit[];
    diagnostics: Array<{ code: string; message: string; range: SourceRange }>;
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

export type HostMessage =
    | { type: 'snapshot'; snapshot: HarnessSnapshot }
    | { type: 'selectUnit'; unitId: string | null };
