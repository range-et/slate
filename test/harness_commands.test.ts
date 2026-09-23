import { describe, expect, it } from 'vitest';

import { commandCompletions, commandHelp, commandToAction, parseCommand, resolveTargets } from '../src/harness/commands';

const targets = [
    { id: 'id-add', label: 'add', detail: 'def add(a: int) -> int', qualifiedName: 'Math.add' },
    { id: 'id-address', label: 'address', detail: 'def address() -> str', qualifiedName: 'User.address' },
];

describe('harness CAD commands', () => {
    it('parses commands case-insensitively without natural-language interpretation', () => {
        expect(parseCommand('  select   Math.add ')).toEqual({ name: 'SELECT', args: ['Math.add'] });
        expect(parseCommand('')).toBeNull();
    });

    it('prefers exact identity and qualified-name matches over fuzzy matches', () => {
        expect(resolveTargets(targets, 'add')).toEqual([targets[0]]);
        expect(resolveTargets(targets, 'id-address')).toEqual([targets[1]]);
        expect(resolveTargets(targets, 'ad')).toEqual(targets);
    });

    it('completes only the command token', () => {
        expect(commandCompletions('re')).toEqual(['REVEAL', 'RECOMPILE']);
        expect(commandCompletions('select ')).toEqual([]);
    });

    it('lists every command and gives exact syntax for mutation commands', () => {
        expect(commandHelp()).toContain('SEARCH');
        expect(commandHelp('stub')).toBe('STUB file.py|Class :: def name(arg: Type) -> Type :: intent');
    });

    it('converts command syntax into typed host actions before crossing the webview boundary', () => {
        expect(commandToAction(parseCommand('context main :: run')!)).toEqual({
            kind: 'setContext', consumer: 'main', dependency: 'run', enabled: true,
        });
        expect(commandToAction(parseCommand('stub math.py :: def add(a: int) -> int :: Add one')!)).toEqual({
            kind: 'createStub', target: 'math.py', signature: 'def add(a: int) -> int', intent: 'Add one',
        });
        expect(commandToAction(parseCommand('lock run maybe')!)).toBeNull();
    });
});
