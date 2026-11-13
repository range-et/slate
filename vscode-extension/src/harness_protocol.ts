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
    /** External import lines declared in the node JSON (`imports`). */
    imports?: string[];
    /** Explicit node dependencies declared in the node JSON (`uses`). */
    uses?: string[];
    /** Per-node verification status badge (S-513). */
    verification?: NodeVerificationResult;
    /** Derived usage info across instances and dependencies (S-502). */
    usage?: NodeUsageInfo;
    /** Structured cases on this node (S-602). */
    cases?: TestCase[];
    /** Guardrails report covering node cases and all affected flow cases (S-602). */
    guardrails?: NodeGuardrailsReport;
}

export interface TestCase {
    id: string;
    description?: string;
    inputs: Record<string, unknown>;
    expected?: unknown;
    error?: string;
    status?: 'passed' | 'failed' | 'untested';
    actual?: unknown;
    failureReason?: string;
}

export interface FlowGuardrailSummary {
    flowId: string;
    flowName: string;
    totalCases: number;
    passedCases: number;
    failedCases: number;
    failures: Array<{
        caseId?: string;
        description?: string;
        error: string;
    }>;
}

export interface NodeGuardrailsReport {
    nodeId: string;
    passed: boolean;
    timestamp: number;
    nodeCases: {
        total: number;
        passed: number;
        failed: number;
        failures: string[];
    };
    affectedFlows: FlowGuardrailSummary[];
}

export interface NodeUsageSite {
    kind: 'flow_instance' | 'root_instance' | 'code_dependency';
    flowId?: string;
    instanceId?: string;
    nodeId?: string;
    label: string;
}

export interface NodeUsageInfo {
    nodeId: string;
    totalUses: number;
    instanceCount: number;
    dependencyCount: number;
    contextCount: number;
    callSites: NodeUsageSite[];
    contextUsers: string[];
}

export type VerificationState = 'untested' | 'running' | 'passed' | 'failed' | 'mutant_survived' | 'stale';

export interface NodeVerificationResult {
    nodeId: string;
    state: VerificationState;
    timestamp: number;
    sourceHash: string;
    pydanticValid?: boolean;
    testsPassed?: number;
    testsTotal?: number;
    survivingMutants?: number;
    totalMutants?: number;
    diagnostics?: string[];
    traceback?: string;
    mutantDiff?: string;
    retryCount?: number;
}

export type Point = { x: number; y: number };

export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout';

export interface ObservedValue {
    type: string;
    repr: string;
    json: unknown;
}

export interface InstanceRunObservation {
    path: string[];
    instanceId: string;
    status: 'executed' | 'failed' | 'not_executed';
    inputs: Record<string, ObservedValue>;
    outputs: Record<string, ObservedValue>;
    error?: string;
}

export interface FlowExecutionSnapshot {
    runId: string;
    flowId: string;
    status: RunStatus;
    durationMs?: number;
    exitCode?: number | null;
    error?: string;
    stdout?: string;
    stderr?: string;
    observations: InstanceRunObservation[];
    valuesByUse: Record<string, ObservedValue>;
    flowOutputs?: Record<string, ObservedValue>;
}

export interface LiveModeState {
    enabled: boolean;
    consented: boolean;
    flowId: string;
}

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
    /** Per-node verification status map (S-513). */
    verifications?: Record<string, NodeVerificationResult>;
    /** Derived usage index for node definitions (S-502). */
    usages?: Record<string, NodeUsageInfo>;
    /** Active or latest flow execution snapshot (S-600). */
    execution?: FlowExecutionSnapshot;
    /** Guardrails reports by node id (S-602). */
    guardrails?: Record<string, NodeGuardrailsReport>;
    /** Live mode status (S-603). */
    liveMode?: LiveModeState;
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

/** An instance calls a node, flow, or library unit (`node`), is a literal value (`kind: 'value'`), or is a pinned viewer (`kind: 'viewer'`). */
export interface FlowInstance {
    id: string;
    node?: string;
    kind?: 'value' | 'viewer';
    value?: unknown;
    pinned?: boolean;
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
    cases?: TestCase[];
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
    omittedNeighbors?: string[];
}

export interface HarnessProposal {
    id: string;
    unitId: string;
    path: string;
    candidate: string;
    implementation?: string;
    check?: string;
    checks: string[];
    staleMessage?: string;
}

export type HostMessage =
    | { type: 'snapshot'; snapshot: HarnessSnapshot }
    | { type: 'selectUnit'; unitId: string | null }
    | { type: 'focus'; target?: string; region?: { x: number; y: number; width?: number; height?: number }; zoom?: number; duration?: number }
    | { type: 'commandResult'; ok: boolean; message: string }
    | { type: 'searchResults'; query: string; results: HarnessSearchResult[]; stale: boolean }
    | { type: 'packetPreview'; unitId: string; packet?: PacketPreview; error?: string }
    | { type: 'generationStarted'; unitId: string; message: string }
    | { type: 'generationProgress'; unitId: string; receivedCharacters: number }
    | { type: 'generationFailed'; unitId: string; message: string }
    | { type: 'proposalReady'; proposal: HarnessProposal }
    | { type: 'proposalStale'; proposalId: string; message: string }
    | { type: 'proposalAccepted'; unitId: string }
    | { type: 'describeState'; running: boolean }
    | { type: 'verificationStatus'; result: NodeVerificationResult }
    | { type: 'verificationBatch'; results: Record<string, NodeVerificationResult> }
    | { type: 'executionStatus'; execution: FlowExecutionSnapshot }
    | { type: 'guardrailsStatus'; report: NodeGuardrailsReport }
    | { type: 'liveModeStatus'; liveMode: LiveModeState };
