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
    /** Folder mode: the node's code text (unit ranges are relative to it). */
    source?: string;
}

export interface HarnessSnapshot {
    revision: number;
    projectName: string;
    /** 'folder' = decoupled slate/ node JSON; absent = legacy project-v2 source map. */
    mode?: 'folder';
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

export interface HarnessSearchResult {
    unitId: string;
    path: string;
    qualifiedName: string;
    signature: string | null;
    snippet: string;
    reason: 'exact name' | 'name' | 'signature' | 'annotation' | 'source' | 'path';
    score: number;
}

export interface PacketPreview {
    items: Array<{
        id: string;
        path: string;
        qualifiedName: string;
        role: 'target' | 'required-context';
        sourceHash: string;
        characters: number;
    }>;
    estimatedInputTokens: number;
    inputBudgetTokens: number;
    outputBudgetTokens: number;
}

export interface HarnessProposal {
    id: string;
    unitId: string;
    path: string;
    candidate: string;
    checks: string[];
    staleMessage?: string;
}

export type HostMessage =
    | { type: 'snapshot'; snapshot: HarnessSnapshot }
    | { type: 'selectUnit'; unitId: string | null }
    | { type: 'commandResult'; ok: boolean; message: string }
    | { type: 'searchResults'; query: string; results: HarnessSearchResult[]; stale: boolean }
    | { type: 'packetPreview'; unitId: string; packet?: PacketPreview; error?: string }
    | { type: 'generationStarted'; unitId: string; message: string }
    | { type: 'generationProgress'; unitId: string; receivedCharacters: number }
    | { type: 'generationFailed'; unitId: string; message: string }
    | { type: 'proposalReady'; proposal: HarnessProposal }
    | { type: 'proposalStale'; proposalId: string; message: string }
    | { type: 'proposalAccepted'; unitId: string };
