export const EMBEDDED_NODE_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://slate.dev/schemas/slate-node.schema.json',
    title: 'SlateNode',
    description: 'Schema for an atomic library unit node in Slate (bounded by JPL-60: <=60 lines per function node, required intent and contract)',
    type: 'object',
    required: [
        'slate',
        'name',
        'intent',
        'contract',
        'code',
    ],
    properties: {
        slate: {
            type: 'integer',
            const: 3,
            description: 'Slate workspace format version (always 3)',
        },
        name: {
            type: 'string',
            pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            description: 'Identifier name of the atomic node (matches file basename and Python function name)',
        },
        language: {
            type: 'string',
            description: 'Target language (defaults to python if omitted)',
        },
        kind: {
            type: 'string',
            enum: ['prelude', 'epilogue', 'class'],
            description: 'Special node kind: module state (`prelude`/`epilogue`) or class frame container (`class`)',
        },
        classOwner: {
            type: 'string',
            minLength: 1,
            pattern: '\\S',
            description: 'Owning class frame node ID when this atomic node represents a class method',
        },
        intent: {
            type: 'string',
            minLength: 1,
            pattern: '\\S',
            description: "Required non-empty high-level summary of the node's intent",
        },
        contract: {
            type: 'string',
            minLength: 1,
            pattern: '\\S',
            description: 'Required documentation of invariants, error handling, and behavioral contract',
        },
        cases: {
            type: 'array',
            description: 'Structured verification cases/checks readiness indicator',
            items: {
                oneOf: [
                    { type: 'string' },
                    {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            description: { type: 'string' },
                            input: { type: ['object', 'array'] },
                            inputs: { type: ['object', 'array'] },
                            expected: { type: ['string', 'number', 'boolean', 'null', 'array', 'object'] },
                            error: { type: 'string' },
                            expectedError: { type: 'string' },
                            approx: { type: ['boolean', 'number'] },
                            code: { type: 'string' },
                        },
                        additionalProperties: true,
                    },
                ],
            },
        },
        check: {
            type: 'array',
            description: 'Pytest unit check / contract validator lines for the node',
            items: {
                type: 'string',
            },
        },
        verification: {
            type: 'object',
            description: 'Per-node verification result (Pydantic contract, pytest checks, mutmut mutation testing)',
            properties: {
                state: {
                    type: 'string',
                    enum: ['untested', 'running', 'passed', 'failed', 'mutant_survived', 'stale'],
                },
                timestamp: {
                    type: 'number',
                },
                sourceHash: {
                    type: 'string',
                },
                testsPassed: {
                    type: 'integer',
                },
                testsTotal: {
                    type: 'integer',
                },
                survivingMutants: {
                    type: 'integer',
                },
                totalMutants: {
                    type: 'integer',
                },
                diagnostics: {
                    type: 'array',
                    items: { type: 'string' },
                },
                traceback: {
                    type: 'string',
                },
                mutantDiff: {
                    type: 'string',
                },
                retryCount: {
                    type: 'integer',
                },
            },
        },
        context: {
            type: 'array',
            description: 'Node IDs referenced for background context/readiness',
            items: {
                type: 'string',
            },
        },
        examples: {
            type: 'array',
            description: 'Example calls or doctests',
            items: {
                type: 'string',
            },
        },
        describedBy: {
            type: 'string',
            enum: ['human', 'llama'],
            description: 'Provenance of the intent/contract description',
        },
        locked: {
            type: 'boolean',
            description: 'Whether the node is locked against local LLM modification',
        },
        order: {
            type: 'integer',
            description: 'Compile order within the output module',
        },
        imports: {
            type: 'array',
            description: 'External import statements needed by this node',
            items: {
                type: 'string',
            },
        },
        uses: {
            type: 'array',
            description: 'Other Slate node IDs this node depends on',
            items: {
                type: 'string',
            },
        },
        code: {
            type: 'array',
            description: 'Python source lines bounded by JPL-60 (<=60 lines per atomic function/method node; class frames and module state are exempt)',
            items: {
                type: 'string',
            },
        },
    },
    if: {
        properties: {
            kind: {
                enum: ['class', 'prelude', 'epilogue'],
            },
        },
        required: ['kind'],
    },
    then: {},
    else: {
        properties: {
            code: {
                type: 'array',
                maxItems: 60,
            },
        },
    },
    additionalProperties: true,
} as const;

export const EMBEDDED_FLOW_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://slate.dev/schemas/slate-flow.schema.json',
    title: 'SlateFlow',
    description: 'Schema for a composition flow graph in Slate',
    type: 'object',
    required: [
        'slate',
        'name',
    ],
    properties: {
        slate: {
            type: 'integer',
            const: 3,
            description: 'Slate workspace format version (always 3)',
        },
        name: {
            type: 'string',
            pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
            description: 'Flow name identifier',
        },
        description: {
            type: 'string',
            description: 'Optional human description of the flow',
        },
        inputs: {
            type: 'array',
            description: 'Flow input ports',
            items: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                    },
                    annotation: {
                        type: ['string', 'null'],
                    },
                },
                additionalProperties: false,
            },
        },
        outputs: {
            type: 'array',
            description: 'Flow output ports',
            items: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                    },
                    annotation: {
                        type: ['string', 'null'],
                    },
                },
                additionalProperties: false,
            },
        },
        instances: {
            type: 'array',
            description: 'Node or flow instances in this composition',
            items: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9_:/-]+$',
                    },
                    node: {
                        type: 'string',
                    },
                    flow: {
                        type: 'string',
                    },
                    kind: {
                        type: 'string',
                    },
                    value: {
                        type: ['string', 'number', 'boolean', 'null', 'array', 'object'],
                    },
                    pinned: {
                        type: 'boolean',
                    },
                },
                additionalProperties: false,
            },
        },
        wires: {
            type: 'array',
            description: 'Directed connections between port endpoints',
            items: {
                type: 'object',
                required: ['from', 'to'],
                properties: {
                    from: {
                        type: 'string',
                    },
                    to: {
                        type: 'string',
                    },
                },
                additionalProperties: false,
            },
        },
        cases: {
            type: 'array',
            description: 'Structured regression test cases for the flow',
            items: {
                type: 'object',
                required: ['inputs'],
                properties: {
                    id: {
                        type: 'string',
                    },
                    description: {
                        type: 'string',
                    },
                    inputs: {
                        type: 'object',
                    },
                    expected: {
                        type: ['string', 'number', 'boolean', 'null', 'array', 'object'],
                    },
                    error: {
                        type: 'string',
                    },
                },
                additionalProperties: true,
            },
        },
        regions: {
            type: 'array',
            description: 'Explicit control flow regions (branch, foreach, repeat)',
            items: {
                type: 'object',
                required: ['id', 'kind'],
                oneOf: [
                    { properties: { kind: { const: 'branch' } }, required: ['thenFlow'] },
                    { properties: { kind: { const: 'foreach' } }, required: ['bodyFlow'] },
                    { properties: { kind: { const: 'repeat' } }, required: ['bodyFlow', 'maxIterations'] },
                ],
                properties: {
                    id: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9_-]+$',
                    },
                    kind: {
                        type: 'string',
                        enum: ['branch', 'foreach', 'repeat'],
                    },
                    label: {
                        type: 'string',
                    },
                    conditionPort: {
                        type: 'string',
                        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                    },
                    thenFlow: {
                        type: 'string',
                        minLength: 1,
                    },
                    elseFlow: {
                        type: 'string',
                        minLength: 1,
                    },
                    bodyFlow: {
                        type: 'string',
                        minLength: 1,
                    },
                    collectionPort: {
                        type: 'string',
                        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                    },
                    itemPort: {
                        type: 'string',
                        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                    },
                    indexPort: {
                        type: 'string',
                        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                    },
                    maxIterations: {
                        type: 'integer',
                        minimum: 1,
                    },
                    statePorts: {
                        type: 'array',
                        items: {
                            type: 'string',
                            pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
                        },
                    },
                },
                additionalProperties: false,
            },
        },
    },
    additionalProperties: true,
} as const;
