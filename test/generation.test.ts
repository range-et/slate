import { describe, expect, it } from 'vitest';

import { buildGenerationPacket, stripModelEnvelope } from '../vscode-extension/src/generation';
import { PythonAdapter } from '../vscode-extension/src/python_adapter';

describe('bounded generation packet', () => {
    it('includes exact named required context without silently truncating it', async () => {
        const adapter = new PythonAdapter();
        const source = `## @slate v=2 id=helper\n## intent: Add one\n## locked: true\n## @slate-end\ndef helper(value: int) -> int:\n    return value + 1\n\n## @slate v=2 id=target\n## intent: Double after adding one\n## contract: Return an integer\n## depends-on: helper\n## locked: false\n## @slate-end\ndef target(value: int) -> int:\n    raise NotImplementedError("Slate stub")\n`;
        const parsed = await adapter.parseModule(source, 'demo.py');
        const snapshot = {
            revision: 1,
            projectName: 'demo',
            documents: [{ ...parsed, id: 'document:demo.py', version: 1, stale: false }],
        };
        const packet = buildGenerationPacket(snapshot, new Map([['demo.py', source]]), 'target', 4096, 512);

        expect(packet.items.map(item => [item.role, item.qualifiedName])).toEqual([
            ['target', 'target'],
            ['required-context', 'helper'],
        ]);
        expect(packet.prompt).toContain('def helper(value: int) -> int:');
        expect(packet.prompt).toContain('Context is reference material; it does not imply an import or call dependency.');
    });

    it('fails rather than dropping required context when the packet is oversized', async () => {
        const adapter = new PythonAdapter();
        const source = `## @slate v=2 id=target\n## intent: ${'Long intent '.repeat(500)}\n## locked: false\n## @slate-end\ndef target(value: int) -> int:\n    return value\n`;
        const parsed = await adapter.parseModule(source, 'demo.py');
        const snapshot = { revision: 1, projectName: 'demo', documents: [{ ...parsed, id: 'document:demo.py', version: 1, stale: false }] };
        expect(() => buildGenerationPacket(snapshot, new Map([['demo.py', source]]), 'target', 1024, 512))
            .toThrow(/was not truncated/);
    });

    it('unwraps one model markdown fence but leaves code otherwise intact', () => {
        expect(stripModelEnvelope('```python\ndef run() -> int:\n    return 1\n```')).toBe('def run() -> int:\n    return 1');
    });
});
