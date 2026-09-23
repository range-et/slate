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
    notes?: BoardNote[];
    contextEdges?: HarnessGraphEdge[];
    layout?: Record<string, { x: number; y: number }>;
}

export interface BoardNote {
    id: string;
    title: string;
    body: string;
    attachedTo: string | null;
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
