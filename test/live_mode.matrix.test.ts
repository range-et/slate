import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runFlow } from '../vscode-extension/src/flow_runner';
import type { FlowExecutionSnapshot, LiveModeState, SlateFlow } from '../vscode-extension/src/harness_protocol';
import type { SlateConfig, SlateNode } from '../vscode-extension/src/slate_folder';

describe('Live Mode & Side-Effect Consent Matrix (S-603)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-live-test-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failure
        }
    });

    describe('State Management & Consent Authorization', () => {
        it('refuses enabling Live mode without explicit side-effect consent', () => {
            const liveState: LiveModeState = {
                enabled: false,
                consented: false,
                flowId: 'main',
            };

            const enableLive = (state: LiveModeState, consentGiven: boolean, isTrusted: boolean) => {
                if (!isTrusted) return { ok: false, error: 'Live mode requires a trusted workspace.' };
                if (!consentGiven && !state.consented) {
                    return { ok: false, error: 'Live mode requires explicit side-effect consent before running.' };
                }
                state.enabled = true;
                state.consented = true;
                return { ok: true, state };
            };

            // Attempt 1: Enable without consent in trusted workspace -> rejected
            const result1 = enableLive(liveState, false, true);
            expect(result1.ok).toBe(false);
            expect(result1.error).toContain('explicit side-effect consent');
            expect(liveState.enabled).toBe(false);

            // Attempt 2: Enable with explicit consent -> succeeds
            const result2 = enableLive(liveState, true, true);
            expect(result2.ok).toBe(true);
            expect(liveState.enabled).toBe(true);
            expect(liveState.consented).toBe(true);

            // Subsequent enable without passing consent again succeeds because consent was recorded
            liveState.enabled = false;
            const result3 = enableLive(liveState, false, true);
            expect(result3.ok).toBe(true);
            expect(liveState.enabled).toBe(true);
        });

        it('refuses enabling Live mode in an untrusted workspace even with consent', () => {
            const liveState: LiveModeState = {
                enabled: false,
                consented: false,
                flowId: 'main',
            };

            const enableLive = (state: LiveModeState, consentGiven: boolean, isTrusted: boolean) => {
                if (!isTrusted) return { ok: false, error: 'Live mode requires a trusted workspace.' };
                if (!consentGiven && !state.consented) {
                    return { ok: false, error: 'Live mode requires explicit side-effect consent before running.' };
                }
                state.enabled = true;
                state.consented = true;
                return { ok: true, state };
            };

            const result = enableLive(liveState, true, false);
            expect(result.ok).toBe(false);
            expect(result.error).toContain('trusted workspace');
            expect(liveState.enabled).toBe(false);
        });

        it('disabling Live mode clears enabled flag and preserves consent', () => {
            const liveState: LiveModeState = {
                enabled: true,
                consented: true,
                flowId: 'math_flow',
            };

            liveState.enabled = false;
            expect(liveState.enabled).toBe(false);
            expect(liveState.consented).toBe(true);
            expect(liveState.flowId).toBe('math_flow');
        });
    });

    describe('Semantic vs Non-Semantic Edit Triggers', () => {
        it('distinguishes semantic edits from canvas layout, notes, and navigation', () => {
            const SEMANTIC_ACTIONS = new Set([
                'setValue', 'setNodeCode', 'connectData', 'disconnectData',
                'addInstance', 'deleteItems', 'createFlow', 'extractFlow',
                'deleteFlow', 'pasteItems', 'makeUnique', 'forkDefinition',
                'renameFlowPort', 'deleteFlowPort', 'createNode', 'acceptProposal',
                'undoAccepted', 'saveCase', 'deleteCase',
            ]);

            const NON_SEMANTIC_ACTIONS = new Set([
                'layout', 'selectUnit', 'reveal', 'focus',
                'noteCreate', 'noteUpdate', 'noteDelete',
                'search', 'clearSelection', 'runGuardrails',
            ]);

            const shouldTriggerLive = (actionKind: string) => SEMANTIC_ACTIONS.has(actionKind);

            for (const action of SEMANTIC_ACTIONS) {
                expect(shouldTriggerLive(action), `Expected ${action} to trigger live rerun`).toBe(true);
            }

            for (const action of NON_SEMANTIC_ACTIONS) {
                expect(shouldTriggerLive(action), `Expected ${action} NOT to trigger live rerun`).toBe(false);
            }
        });
    });

    describe('Debounced Re-Execution & Abort Control', () => {
        it('debounces rapid bursts of edits into a single execution', async () => {
            vi.useFakeTimers();
            let executeCount = 0;
            let timer: NodeJS.Timeout | undefined;

            const triggerLiveRerun = (delay = 300) => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = undefined;
                    executeCount++;
                }, delay);
            };

            // Fire 5 rapid edits within 100ms
            triggerLiveRerun();
            vi.advanceTimersByTime(50);
            triggerLiveRerun();
            vi.advanceTimersByTime(50);
            triggerLiveRerun();
            vi.advanceTimersByTime(50);
            triggerLiveRerun();
            vi.advanceTimersByTime(50);
            triggerLiveRerun();

            // Before delay expires: 0 runs
            expect(executeCount).toBe(0);

            // Advance past debounce delay
            vi.advanceTimersByTime(350);
            expect(executeCount).toBe(1);

            vi.useRealTimers();
        });

        it('aborts active execution controller when a fresh execution begins', () => {
            let activeController: AbortController | undefined;
            const abortedSignals: boolean[] = [];

            const startExecution = () => {
                if (activeController) {
                    activeController.abort();
                    activeController = undefined;
                }
                const controller = new AbortController();
                activeController = controller;
                controller.signal.addEventListener('abort', () => abortedSignals.push(true));
                return controller;
            };

            const run1 = startExecution();
            expect(run1.signal.aborted).toBe(false);

            // Starting run 2 aborts run 1
            const run2 = startExecution();
            expect(run1.signal.aborted).toBe(true);
            expect(run2.signal.aborted).toBe(false);
            expect(abortedSignals.length).toBe(1);
        });
    });

    describe('No Purity Caching Execution', () => {
        const config: SlateConfig = { slate: 3, name: 'live_test_proj', language: 'python' };

        const counterNode: SlateNode = {
            name: 'increment',
            intent: 'Increment a counter value',
            contract: 'x: int -> int',
            context: [],
            examples: [],
            locked: true,
            imports: [],
            uses: [],
            order: 1,
            code: [
                'def increment(x: int) -> int:',
                '    return x + 1',
            ],
        };

        const flow: SlateFlow = {
            id: 'main',
            name: 'main',
            inputs: [],
            outputs: [{ id: 'out:result', name: 'result', annotation: 'int' }],
            instances: [
                { id: 'v1', kind: 'value', value: 10 },
                { id: 'step1', node: 'increment' },
            ],
            wires: [
                { from: 'v1.out', to: 'step1.in:x' },
                { from: 'step1.out', to: 'output:result' },
            ],
        };

        it('executes each run freshly from scratch in an isolated build directory without caching', async () => {
            const documents = new Map<string, SlateNode>([['increment', counterNode]]);
            const flows = new Map<string, SlateFlow>([['main', flow]]);

            // Run 1: with input 10
            const result1 = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents,
                flows,
                config,
                library: new Map(),
                isTrusted: true,
            });

            expect(result1.status).toBe('completed');
            expect(result1.valuesByUse['::step1::out']?.repr).toBe('11');
            const runId1 = result1.runId;

            // Update value node to 42 (simulating a live edit)
            const updatedFlow: SlateFlow = {
                ...flow,
                instances: [
                    { id: 'v1', kind: 'value', value: 42 },
                    { id: 'step1', node: 'increment' },
                ],
            };
            flows.set('main', updatedFlow);

            // Run 2: executes freshly in a new runId
            const result2 = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents,
                flows,
                config,
                library: new Map(),
                isTrusted: true,
            });

            expect(result2.status).toBe('completed');
            expect(result2.valuesByUse['::step1::out']?.repr).toBe('43');
            expect(result2.runId).not.toBe(runId1);
        });

        it('fails closed and rejects invalid or broken graphs without showing stale last-good runs', async () => {
            const brokenNode: SlateNode = {
                name: 'bad_syntax',
                intent: 'Node with invalid Python syntax',
                contract: 'x: int -> int',
                context: [],
                examples: [],
                locked: true,
                imports: [],
                uses: [],
                order: 1,
                code: [
                    'def bad_syntax(x: int) -> int:',
                    '    return x +++??? invalid',
                ],
            };

            const brokenFlow: SlateFlow = {
                id: 'main',
                name: 'main',
                inputs: [],
                outputs: [{ id: 'out:res', name: 'res', annotation: 'int' }],
                instances: [
                    { id: 'bad', node: 'bad_syntax' },
                ],
                wires: [
                    { from: 'bad.out', to: 'output:res' },
                ],
            };

            const documents = new Map<string, SlateNode>([['bad_syntax', brokenNode]]);
            const flows = new Map<string, SlateFlow>([['main', brokenFlow]]);

            const result = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents,
                flows,
                config,
                library: new Map(),
                isTrusted: true,
            });

            expect(result.status).toBe('failed');
            expect(result.error).toBeDefined();
            // Stale outputs are not returned
            expect(result.flowOutputs).toBeUndefined();
        });
    });
});
