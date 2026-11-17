// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computePipeline, EXPLAINER_NODES, generateCompiledPython, initExplainerStudio } from '../src/explainer';
import { checkLlamaHealth, LlamaTransportError, streamLlamaCompletion } from '../vscode-extension/src/llama_transport';
import {
    AdapterError, identifierNames, parseModule, PythonAdapter, splitImport, topLevelBindings,
} from '../vscode-extension/src/python_adapter';
import { searchUnits } from '../vscode-extension/src/search';
import {
    checkJpl60, indexNode, parseConfig, parseNode, serializeNode, SlateFormatError,
} from '../vscode-extension/src/slate_folder';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('searchUnits branch and boundary hardening (vscode-extension/src/search.ts)', () => {
    const baseUnit = {
        id: 'pkg/target_fn',
        identity: 'durable' as const,
        kind: 'function' as const,
        name: 'target_fn',
        qualifiedName: 'Service.target_fn',
        parentId: null,
        ranges: {
            name: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } },
            declaration: { start: { line: 0, character: 0 }, end: { line: 2, character: 20 } },
        },
         signature: 'def target_fn(timeout_ms: int) -> bool',
        annotation: {
            intent: 'Validate service timeout budget',
            contract: 'timeout_ms > 0',
        },
        decorators: [],
    };

    const baseDoc = {
        id: 'node:pkg/target_fn',
        path: 'slate/nodes/pkg/target_fn.json',
        version: 1,
        stale: false,
        sourceHash: 'sha256:00',
        valid: true,
        units: [baseUnit],
        diagnostics: [],
    };

    it('matches exact unit.id, name prefix, qualifiedName prefix, qualifiedName substring, signature, annotation, source, and path', () => {
        const sourceText = 'def target_fn(timeout_ms: int) -> bool:\r\n    sentinel_value = timeout_ms * 2\r\n    return sentinel_value > 0\r\n';
        const sources = new Map([[baseDoc.path, sourceText]]);

        // 1. Exact unit.id match when name and qualifiedName differ from unit.id
        const byId = searchUnits([baseDoc], sources, 'pkg/target_fn');
        expect(byId).toHaveLength(1);
        expect(byId[0]).toMatchObject({ unitId: 'pkg/target_fn', reason: 'exact name', score: 100 });
        // Source doesn't contain 'pkg/target_fn', so sourceSnippet falls back to signature
        expect(byId[0].snippet).toBe('def target_fn(timeout_ms: int) -> bool');

        // 2. Name prefix match (name starts with query, qualifiedName does not)
        const byNamePrefix = searchUnits([baseDoc], sources, 'target_');
        expect(byNamePrefix[0]).toMatchObject({ reason: 'name', score: 90 });

        // 3. QualifiedName prefix match (qualifiedName starts with query, name does not)
        const byQualPrefix = searchUnits([baseDoc], sources, 'service.t');
        expect(byQualPrefix[0]).toMatchObject({ reason: 'name', score: 90 });

        // 4. QualifiedName substring match (neither starts with query)
        const byQualSub = searchUnits([baseDoc], sources, 'vice.target');
        expect(byQualSub[0]).toMatchObject({ reason: 'name', score: 82 });

        // 5. Signature match
        const bySig = searchUnits([baseDoc], sources, 'timeout_ms: int');
        expect(bySig[0]).toMatchObject({ reason: 'signature', score: 72 });

        // 6. Annotation match on contract line
        const byContract = searchUnits([baseDoc], sources, 'timeout_ms > 0');
        expect(byContract[0]).toMatchObject({ reason: 'annotation', score: 62, snippet: 'timeout_ms > 0' });

        // 7. Source declaration body match with CRLF lines
        const bySource = searchUnits([baseDoc], sources, 'sentinel_value');
        expect(bySource[0]).toMatchObject({
            reason: 'source',
            score: 52,
            snippet: 'sentinel_value = timeout_ms * 2',
        });

        // 8. Document path match when source is missing from map and signature is absent
        const noSigDoc = {
            ...baseDoc,
            units: [{ ...baseUnit, signature: undefined, annotation: null }],
        };
        const byPath = searchUnits([noSigDoc], new Map(), 'slate/nodes/pkg');
        expect(byPath[0]).toMatchObject({
            reason: 'path',
            score: 42,
            signature: null,
            snippet: 'Service.target_fn',
        });

        // 9. Unmatched query is skipped
        expect(searchUnits([baseDoc], sources, 'completely_absent_token')).toEqual([]);
    });
});

describe('slate_folder format and JPL-60 edge branches (vscode-extension/src/slate_folder.ts)', () => {
    it('parses and serializes optional cases, check, and verification fields', () => {
        const raw = {
            slate: 3,
            name: 'compute',
            language: 'python',
            intent: 'Compute value',
            contract: 'x >= 0',
            context: ['helper'],
            cases: [{ inputs: { x: 1 }, expected: 2 }],
            check: ['def test_compute():', '    assert compute(1) == 2'],
            verification: {
                status: 'verified',
                pytestPassed: true,
                mutmutScore: 100,
                summary: 'All checks passed',
            },
            examples: ['compute(1) == 2'],
            describedBy: 'llama',
            locked: false,
            order: 1,
            imports: ['import math'],
            uses: ['helper'],
            code: ['def compute(x: int) -> int:', '    return x + 1'],
        };

        const parsed = parseNode(JSON.stringify(raw));
        expect(parsed.cases).toEqual(raw.cases);
        expect(parsed.check).toEqual(raw.check);
        expect(parsed.verification).toEqual(raw.verification);

        const serialized = serializeNode(parsed);
        expect(parseNode(serialized)).toEqual(parsed);

        // Empty cases/check arrays are omitted in serializeNode; non-array cases and non-record verification are ignored
        const minimal = parseNode(JSON.stringify({
            slate: 3,
            name: 'compute',
            cases: 'not-an-array',
            verification: 'not-a-record',
            code: ['def compute(x: int) -> int:', '    return x'],
        }));
        expect(minimal.cases).toBeUndefined();
        expect(minimal.verification).toBeUndefined();
        const minJson = JSON.parse(serializeNode({ ...minimal, cases: [], check: [] }));
        expect(minJson.cases).toBeUndefined();
        expect(minJson.check).toBeUndefined();

        // Invalid check list throws SlateFormatError
        expect(() => parseNode(JSON.stringify({
            slate: 3,
            name: 'compute',
            check: [123],
            code: ['def compute(x: int) -> int:', '    return x'],
        }))).toThrow(SlateFormatError);

        // Non-record compile in parseConfig throws SlateFormatError
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', compile: null }))).toThrow(/compile\.outDir/);
    });

    it('evaluates checkJpl60 with omitted code argument, comments/blanks, prelude nodes, classes, and missing contract', () => {
        const nodeWithComments = parseNode(JSON.stringify({
            slate: 3,
            name: 'calc',
            contract: '   ',
            code: [
                '# Leading comment',
                '',
                'def calc(x, y: int):',
                '    # Inside comment',
                '    return x + y',
            ],
        }));

        // Calling checkJpl60 without second argument uses node.code
        const res = checkJpl60(nodeWithComments);
        expect(res.valid).toBe(false);
        expect(res.lineCount).toBe(5);
        expect(res.executableLines).toBe(2);
        expect(res.diagnostics.map(d => d.code)).toEqual([
            'jpl60-param-annotation',
            'jpl60-return-annotation',
            'jpl60-contract-missing',
        ]);

        // Prelude node skips line-count and function signature checks
        const preludeNode = parseNode(JSON.stringify({
            slate: 3,
            name: '_prelude',
            kind: 'prelude',
            contract: 'Module constants',
            code: Array.from({ length: 65 }, (_, i) => `CONST_${i} = ${i}`),
        }));
        const preludeRes = checkJpl60(preludeNode);
        expect(preludeRes.valid).toBe(true);
        expect(preludeRes.lineCount).toBe(65);

        // Class node with contract passes without function param/return diagnostics
        const classNode = parseNode(JSON.stringify({
            slate: 3,
            name: 'Box',
            contract: 'Box container',
            code: ['class Box:', '    pass'],
        }));
        expect(checkJpl60(classNode).valid).toBe(true);

        // indexNode with checkJpl60 on a valid function without contract reports jpl60-contract-missing
        const indexed = indexNode('slate/nodes/calc.json', JSON.stringify({
            slate: 3,
            name: 'calc',
            code: ['def calc(x: int) -> int:', '    return x'],
        }), 'python', 1, { checkJpl60: true });
        expect(indexed.document.diagnostics.map(d => d.code)).toContain('jpl60-contract-missing');
    });
});

describe('python_adapter import splitting, bindings, and replacement validation (vscode-extension/src/python_adapter.ts)', () => {
    it('splits plain, aliased, relative, parenthesized, and wildcard imports, and ignores non-imports', () => {
        expect(splitImport('')).toEqual([]);
        expect(splitImport('x = 1')).toEqual([]);

        expect(splitImport('from .pkg.sub import (alpha, beta as b)')).toEqual([
            { line: 'from .pkg.sub import alpha', binding: 'alpha', module: '.pkg.sub', name: 'alpha' },
            { line: 'from .pkg.sub import beta as b', binding: 'b', module: '.pkg.sub', name: 'beta' },
        ]);

        expect(splitImport('from .pkg.sub import *')).toEqual([
            { line: 'from .pkg.sub import *', binding: null, module: '.pkg.sub', name: '*' },
        ]);

        expect(splitImport('import os, pkg.mod as pm, a.b.c')).toEqual([
            { line: 'import os', binding: 'os', module: 'os', name: null },
            { line: 'import pkg.mod as pm', binding: 'pm', module: 'pkg.mod', name: null },
            { line: 'import a.b.c', binding: 'a', module: 'a.b.c', name: null },
        ]);
    });

    it('extracts identifierNames and topLevelBindings across control flow blocks', () => {
        const src = [
            'import os',
            'from math import sin as sine',
            'from wildcard_mod import *',
            'a = b = 10',
            'if a > 0:',
            '    def cond_fn(param_x: int) -> int:',
            '        local_var = param_x + 1',
            '        return local_var',
            'try:',
            '    class CondClass:',
            '        pass',
            'except Exception:',
            '    fallback_val = 0',
            'with ctx():',
            '    @decorated',
            '    def with_fn() -> None:',
            '        pass',
        ].join('\n');

        const bindings = topLevelBindings(src);
        expect([...bindings].sort()).toEqual([
            'CondClass', 'a', 'b', 'cond_fn', 'fallback_val', 'os', 'sine', 'with_fn',
        ]);
        expect(bindings.has('local_var')).toBe(false);

        const ids = identifierNames(src);
        expect(ids.has('local_var')).toBe(true);
        expect(ids.has('param_x')).toBe(true);
        expect(ids.has('sine')).toBe(true);
    });

    it('validates replaceUnit required string parameters, missing units, and signature/decorator preservation', async () => {
        const adapter = new PythonAdapter();
        const source = 'def compute(x: int) -> int:\n    return x\n';
        const parsed = await adapter.parseModule(source, 'compute.py', 'compute');

        await expect(adapter.replaceUnit({
            source: 123, path: 'compute.py', expectedHash: parsed.sourceHash, unitId: 'compute', replacement: source,
        })).rejects.toThrow('source must be a string');

        await expect(adapter.replaceUnit({
            source, path: null, expectedHash: parsed.sourceHash, unitId: 'compute', replacement: source,
        })).rejects.toThrow('path must be a string');

        await expect(adapter.replaceUnit({
            source, path: 'compute.py', expectedHash: parsed.sourceHash, unitId: 99, replacement: source,
        })).rejects.toThrow('unitId must be a string');

        await expect(adapter.replaceUnit({
            source, path: 'compute.py', nodeId: 'compute', expectedHash: parsed.sourceHash, unitId: 'compute', replacement: null,
        })).rejects.toThrow('replacement must be a string');

        await expect(adapter.replaceUnit({
            source, path: 'compute.py', expectedHash: parsed.sourceHash, unitId: 'missing', replacement: source,
        })).rejects.toThrow('unit id "missing" resolved to 0 declarations; expected exactly one');

        await expect(adapter.replaceUnit({
            source,
            path: 'compute.py',
            nodeId: 'compute',
            expectedHash: parsed.sourceHash,
            unitId: 'compute',
            replacement: 'def other_name(x: int) -> int:\n    return 1',
        })).rejects.toThrow('replacement must preserve the function name, signature, and decorators');

        await expect(adapter.replaceUnit({
            source,
            path: 'compute.py',
            nodeId: 'compute',
            expectedHash: parsed.sourceHash,
            unitId: 'compute',
            replacement: 'def compute(x: str) -> int:\n    return 1',
        })).rejects.toThrow('replacement must preserve the function name, signature, and decorators');

        await expect(adapter.replaceUnit({
            source,
            path: 'compute.py',
            nodeId: 'compute',
            expectedHash: parsed.sourceHash,
            unitId: 'compute',
            replacement: '@extra\ndef compute(x: int) -> int:\n    return 1',
        })).rejects.toThrow('replacement must contain exactly one valid function');

        expect(() => adapter.dispose()).not.toThrow();
    });
});

describe('checkLlamaHealth and streamLlamaCompletion edge branches (vscode-extension/src/llama_transport.ts)', () => {
    it('reports available models from /v1/models and normalizes /v1 suffixes', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            data: [{ id: 'qwen2.5-coder' }, { id: '' }, {}, { id: 'llama-3' }],
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await checkLlamaHealth('http://localhost:8080/v1/', 'qwen2.5-coder');
        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:8080/v1/models',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(res).toEqual({
            ok: true,
            endpoint: 'http://localhost:8080/v1/',
            model: 'qwen2.5-coder',
            statusText: 'Connected (2 model(s) available)',
            models: ['qwen2.5-coder', 'llama-3'],
        });
    });

    it('falls back to /health when /v1/models throws or returns non-OK, and tolerates plaintext health responses', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new Error('models route disabled'))
            .mockResolvedValueOnce(new Response('OK', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await checkLlamaHealth('http://localhost:8080/');
        expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:8080/v1/models', expect.anything());
        expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8080/health', expect.anything());
        expect(res).toEqual({
            ok: true,
            endpoint: 'http://localhost:8080/',
            model: undefined,
            statusText: 'Connected',
            models: [],
        });
    });

    it('reports HTTP status errors and network error messages when both /v1/models and /health fail', async () => {
        // HTTP status with statusText and with empty statusText
        vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503, statusText: 'Service Unavailable' })));
        const http503 = await checkLlamaHealth('http://localhost:8080');
        expect(http503).toEqual({
            ok: false,
            endpoint: 'http://localhost:8080',
            model: undefined,
            statusText: 'HTTP 503 Service Unavailable',
        });

        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500, statusText: '' })));
        const http500 = await checkLlamaHealth('http://localhost:8080');
        expect(http500.statusText).toBe('HTTP 500 Error');

        // Both endpoints throw Error
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }));
        const netErr = await checkLlamaHealth('http://localhost:8080');
        expect(netErr).toEqual({
            ok: false,
            endpoint: 'http://localhost:8080',
            model: undefined,
            statusText: 'ECONNREFUSED',
        });

        // Both endpoints reject with null -> 'Endpoint unreachable'
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw null;
        }));
        const nullErr = await checkLlamaHealth('http://localhost:8080');
        expect(nullErr.statusText).toBe('Endpoint unreachable');

        // Outer catch block when endpoint manipulation throws Error or non-Error
        const throwingEndpointErr = {
            replace: () => { throw new Error('Invalid endpoint object'); },
        } as unknown as string;
        expect((await checkLlamaHealth(throwingEndpointErr)).statusText).toBe('Invalid endpoint object');

        const throwingEndpointStr = {
            replace: () => { throw 'raw endpoint failure'; },
        } as unknown as string;
        expect((await checkLlamaHealth(throwingEndpointStr)).statusText).toBe('raw endpoint failure');
    });

    it('reports Connection timed out when aborted during /v1/models or during /health fallback', async () => {
        // Abort during first fetch (/v1/models)
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })));
        const firstTimeout = await checkLlamaHealth('http://localhost:8080', 'local', 10);
        expect(firstTimeout).toEqual({
            ok: false,
            endpoint: 'http://localhost:8080',
            model: 'local',
            statusText: 'Connection timed out',
        });

        // First fetch returns 404 immediately, second fetch (/health) times out
        let call = 0;
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
            call++;
            if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        }));
        const secondTimeout = await checkLlamaHealth('http://localhost:8080', 'local', 10);
        expect(secondTimeout.statusText).toBe('Connection timed out');
    });

    it('uses the default system prompt in streamLlamaCompletion when options.system is omitted', async () => {
        const sse = 'data: {"choices":[{"delta":{"content":"def f(): pass"}}]}\n\ndata: [DONE]\n\n';
        const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const out = await streamLlamaCompletion('prompt', {
            endpoint: 'http://localhost:8080',
            model: 'm',
            outputTokens: 32,
            timeoutMs: 1000,
        }, new AbortController().signal, () => {});
        expect(out).toBe('def f(): pass');
        const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(body.messages[0].content).toContain('constrained Python function implementation engine');
    });
});

describe('Explainer interactive DOM studio and tier boundaries (src/explainer.ts)', () => {
    it('evaluates exact tier boundaries at 0.85 and 0.60', () => {
        expect(computePipeline(8.5).tier).toBe('TIER_A (Excellent)');
        expect(computePipeline(8.49).tier).toBe('TIER_B (Proficient)');
        expect(computePipeline(6.0).tier).toBe('TIER_B (Proficient)');
        expect(computePipeline(5.99).tier).toBe('TIER_C (Needs Review)');
        expect(generateCompiledPython(6.0)).toContain('score_pipeline(6) -> "TIER_B (Proficient)"');
    });

    it('mounts safely on an empty DOM and drives all interactive controls when present', () => {
        // Empty DOM should not throw
        expect(() => initExplainerStudio()).not.toThrow();

        document.body.innerHTML = `
            <input id="explainer-slider" type="range" value="12.5" />
            <input id="explainer-num" type="number" value="12.5" />
            <span id="port-val-input"></span>
            <span id="port-val-clamped"></span>
            <span id="port-val-norm"></span>
            <span id="port-val-tier"></span>
            <div id="inspector-title"></div>
            <div id="inspector-sig"></div>
            <div id="inspector-lines"></div>
            <pre id="inspector-code"></pre>
            <pre id="inspector-tests"></pre>
            <pre id="inspector-packet"></pre>
            <span id="inspector-tokens"></span>
            <pre id="inspector-compiled"></pre>
            <button data-inspector-tab="code"></button>
            <button data-inspector-tab="packet"></button>
            <button data-inspector-tab="compiled"></button>
            <div data-tab-pane="code"></div>
            <div data-tab-pane="packet"></div>
            <div data-tab-pane="compiled"></div>
            <div data-node-id="clamp"></div>
            <div data-node-id="normalize"></div>
            <div data-node-id="evaluate_tier"></div>
            <div data-node-id="unknown_node"></div>
            <button data-walkthrough-step="1"></button>
            <button data-walkthrough-step="2"></button>
            <button data-walkthrough-step="3"></button>
            <button data-walkthrough-step="4"></button>
            <button data-walkthrough-step="99"></button>
            <div id="walkthrough-callout"></div>
            <button id="sim-forge-btn"></button>
            <div id="forge-sim-status"></div>
        `;

        initExplainerStudio();

        const slider = document.getElementById('explainer-slider') as HTMLInputElement;
        const numInput = document.getElementById('explainer-num') as HTMLInputElement;
        const tierDisplay = document.getElementById('port-val-tier')!;
        const inspectorTitle = document.getElementById('inspector-title')!;
        const forgeStatus = document.getElementById('forge-sim-status')!;

        expect(inspectorTitle.textContent).toBe('fn clamp');
        expect(tierDisplay.textContent).toBe('TIER_A (Excellent)');

        // Slider input updates numInput and pipeline
        slider.value = '7.2';
        slider.dispatchEvent(new Event('input'));
        expect(numInput.value).toBe('7.2');
        expect(tierDisplay.textContent).toBe('TIER_B (Proficient)');

        // Number input updates slider and falls back to 0 when empty/NaN
        numInput.value = '';
        numInput.dispatchEvent(new Event('input'));
        expect(slider.value).toBe('0');
        expect(tierDisplay.textContent).toBe('TIER_C (Needs Review)');

        // Clicking node cards switches inspector and ignores unknown node IDs
        const normCard = document.querySelector<HTMLElement>('[data-node-id="normalize"]')!;
        normCard.click();
        expect(inspectorTitle.textContent).toBe('fn normalize');
        document.querySelector<HTMLElement>('[data-node-id="unknown_node"]')!.click();
        expect(inspectorTitle.textContent).toBe('fn normalize');

        // Clicking tabs switches visible pane
        const packetTabBtn = document.querySelector<HTMLButtonElement>('[data-inspector-tab="packet"]')!;
        packetTabBtn.click();
        expect(document.querySelector<HTMLElement>('[data-tab-pane="packet"]')!.style.display).toBe('block');
        expect(document.querySelector<HTMLElement>('[data-tab-pane="code"]')!.style.display).toBe('none');

        // Walkthrough steps 1..4 update node, tab, and callout; unknown step is ignored
        for (const step of ['1', '2', '3', '4']) {
            document.querySelector<HTMLButtonElement>(`[data-walkthrough-step="${step}"]`)!.click();
            expect(document.getElementById('walkthrough-callout')!.innerHTML).toContain(`Step ${step}:`);
        }
        document.querySelector<HTMLButtonElement>('[data-walkthrough-step="99"]')!.click();
        expect(document.getElementById('walkthrough-callout')!.innerHTML).toContain('Step 4:');

        // Simulate local forge and accept candidate
        document.getElementById('sim-forge-btn')!.click();
        expect(forgeStatus.style.display).toBe('block');
        expect(forgeStatus.innerHTML).toContain(String(EXPLAINER_NODES.evaluate_tier.packet.tokens));
        const acceptBtn = document.getElementById('sim-accept-btn')!;
        acceptBtn.click();
        expect(forgeStatus.innerHTML).toContain('slate/nodes/evaluate_tier.json');
    });
});
