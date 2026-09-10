import { describe, expect, it } from 'vitest';

import { commandCompletions, commandHelp, parseCommand, resolveTargets } from '../src/harness/commands';

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
        expect(commandCompletions('re')).toEqual(['REVEAL', 'REASSIGN', 'RECOMPILE']);
        expect(commandCompletions('select ')).toEqual([]);
    });

    it('lists every command and gives exact syntax for mutation commands', () => {
        expect(commandHelp()).toContain('REASSIGN');
        expect(commandHelp('stub')).toBe('STUB file.py|Class :: def name(arg: Type) -> Type :: intent');
    });
});
