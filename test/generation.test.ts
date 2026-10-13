import { describe, expect, it } from 'vitest';

import { buildGenerationPacket, stripModelEnvelope } from '../vscode-extension/src/generation';
import { indexNode } from '../vscode-extension/src/slate_folder';

describe('bounded generation packet', () => {
    it('fails rather than dropping required context when the packet is oversized', () => {
        const target = indexNode('slate/nodes/target.json', JSON.stringify({
            slate: 3, name: 'target', intent: 'Long intent '.repeat(500), locked: false,
            code: ['def target(value: int) -> int:', '    return value'],
        }), 'python', null);
        const snapshot = { revision: 1, projectName: 'demo', documents: [target.document] };
        expect(() => buildGenerationPacket(snapshot, new Map([[target.document.path, target.code]]), 'target', 1024, 512))
            .toThrow(/was not truncated/);
    });

    it('unwraps one model markdown fence but leaves code otherwise intact', () => {
        expect(stripModelEnvelope('```python\ndef run() -> int:\n    return 1\n```')).toBe('def run() -> int:\n    return 1');
    });
});
