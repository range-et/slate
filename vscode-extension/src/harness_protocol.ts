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
    };
    annotation: Record<string, unknown> | null;
    decorators: string[];
    async?: boolean;
    parameters?: string;
    /** Structured parameters (functions only); `positional` = positional-only. */
    params?: UnitParam[];
    returnAnnotation?: string | null;
    signature?: string;
}

export interface UnitParam {
    name: string;
    annotation: string | null;
    default: string | null;
    kind: 'positional' | 'keyword' | 'var' | 'kwvar';
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
    /** The node's code text (unit ranges are relative to it). */
    source?: string;
    /** Module state (`prelude`/`epilogue`) instead of one definition. */
    nodeKind?: 'prelude' | 'epilogue';
}

export type Point = { x: number; y: number };

export interface HarnessSnapshot {
    revision: number;
    projectName: string;
    documents: HarnessDocument[];
    notes?: BoardNote[];
    contextEdges?: HarnessGraphEdge[];
    /** Root (Compose) canvas positions by canvas id. */
    layout?: Record<string, Point>;
    /** Map view positions by node id. */
    mapPositions?: Record<string, Point>;
    /** Flow canvas positions: flow id → instance id (or `__input`/`__output`) → point. */
    flowPositions?: Record<string, Record<string, Point>>;
    refs?: CanvasRef[];
    placeholders?: Placeholder[];
    flows?: HarnessFlow[];
    library?: LibraryDocument[];
}

/** A canvas alias of a node, flow, or library unit (stored in layout.json). */
export interface CanvasRef {
    id: string;
    target: string;
}

/** A name-only stand-in for a node that may not exist yet (stored in layout.json). */
export interface Placeholder {
    id: string;
    name: string;
    signature?: string;
}

export interface FlowPort {
    name: string;
    annotation: string | null;
}

/** An instance calls a node, flow, or library unit (`node`), or is a literal value (`kind: 'value'`, Python expression). */
export interface FlowInstance {
    id: string;
    node?: string;
    kind?: 'value';
    value?: string;
}

/** Endpoints: `<instance>.out`, `<instance>.out:<name>`, `<instance>.in:<param>`, `input:<name>`, `output:<name>`. */
export interface FlowWire {
    from: string;
    to: string;
}

export interface SlateFlow {
    name: string;
    inputs: FlowPort[];
    outputs: FlowPort[];
    instances: FlowInstance[];
    wires: FlowWire[];
    /** Unknown keys, preserved on write. */
    extra: Record<string, unknown>;
}

export interface HarnessFlow {
    /** Path under slate/flows without `.json`; `main` is the root canvas. */
    id: string;
    flow: SlateFlow | null;
    problem?: string;
}

/** Read-only library code from slate.json `library`; top-level unit ids are `lib:<path>:<qualifiedName>`. */
export interface LibraryDocument {
    path: string;
    units: ParsedUnit[];
    problem?: string;
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

// Webview-facing messages and views (shared with src/harness via types.ts).

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
    | { type: 'proposalAccepted'; unitId: string }
    | { type: 'describeState'; running: boolean };
