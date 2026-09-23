export const COMMAND_NAMES = [
    'SEARCH', 'SELECT', 'REVEAL', 'EDIT', 'FIT', 'CLEAR', 'STUB', 'INTENT', 'CONTRACT',
    'CONTEXT', 'UNCONTEXT', 'LOCK', 'COMPILE', 'RECOMPILE', 'SAVE', 'HELP',
] as const;

export type HarnessCommand = {
    name: string;
    args: string[];
};

export type HarnessAction =
    | { kind: 'refreshIndex' }
    | { kind: 'saveWorkspace' }
    | { kind: 'createStub'; target: string; signature: string; intent: string }
    | { kind: 'setAnnotationField'; target: string; field: 'intent' | 'contract'; text: string }
    | { kind: 'setContext'; consumer: string; dependency: string; enabled: boolean }
    | { kind: 'setLock'; target: string; locked: boolean };

export function commandToAction(command: HarnessCommand): HarnessAction | null {
    const raw = command.args.join(' ');
    const parts = raw.split('::').map(part => part.trim());
    if (command.name === 'COMPILE' || command.name === 'RECOMPILE') return { kind: 'refreshIndex' };
    if (command.name === 'SAVE') return { kind: 'saveWorkspace' };
    if (command.name === 'STUB' && parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
        return { kind: 'createStub', target: parts[0], signature: parts[1], intent: parts.slice(2).join(' :: ') };
    }
    if ((command.name === 'INTENT' || command.name === 'CONTRACT') && parts.length >= 2 && parts[0] && parts[1]) {
        return {
            kind: 'setAnnotationField',
            target: parts[0],
            field: command.name === 'INTENT' ? 'intent' : 'contract',
            text: parts.slice(1).join(' :: '),
        };
    }
    if ((command.name === 'CONTEXT' || command.name === 'UNCONTEXT') && parts.length === 2 && parts[0] && parts[1]) {
        return { kind: 'setContext', consumer: parts[0], dependency: parts[1], enabled: command.name === 'CONTEXT' };
    }
    if (command.name === 'LOCK') {
        const lockParts = raw.trim().split(/\s+/);
        if (lockParts.length === 2 && ['ON', 'OFF'].includes(lockParts[1].toUpperCase())) {
            return { kind: 'setLock', target: lockParts[0], locked: lockParts[1].toUpperCase() === 'ON' };
        }
    }
    return null;
}

export type CommandTarget = {
    id: string;
    label: string;
    detail: string;
    qualifiedName?: string;
};

export function parseCommand(input: string): HarnessCommand | null {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    return { name: tokens[0].toUpperCase(), args: tokens.slice(1) };
}

export function resolveTargets(targets: CommandTarget[], query: string): CommandTarget[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const exact = targets.filter(target =>
        target.id.toLowerCase() === normalized
        || target.label.toLowerCase() === normalized
        || target.qualifiedName?.toLowerCase() === normalized
    );
    if (exact.length > 0) return exact;
    return targets.filter(target =>
        target.label.toLowerCase().includes(normalized)
        || target.detail.toLowerCase().includes(normalized)
        || target.qualifiedName?.toLowerCase().includes(normalized)
    );
}

export function commandCompletions(input: string): string[] {
    const normalized = input.trimStart().toUpperCase();
    if (normalized.includes(' ')) return [];
    return COMMAND_NAMES.filter(command => command.startsWith(normalized));
}

const HELP: Record<string, string> = {
    SEARCH: 'SEARCH query or /search — search names, signatures, annotations, and source',
    SELECT: 'SELECT name|id|ALL|NONE',
    REVEAL: 'REVEAL unit — open its source',
    EDIT: 'EDIT unit — open its source for editing',
    STUB: 'STUB file.py|Class :: def name(arg: Type) -> Type :: intent',
    INTENT: 'INTENT unit :: text',
    CONTRACT: 'CONTRACT unit :: text',
    CONTEXT: 'CONTEXT consumer :: dependency',
    UNCONTEXT: 'UNCONTEXT consumer :: dependency',
    LOCK: 'LOCK unit ON|OFF',
    COMPILE: 'COMPILE — re-index and parse-check source',
    RECOMPILE: 'RECOMPILE — alias for COMPILE',
    SAVE: 'SAVE — save dirty workspace files',
    FIT: 'FIT — fit all groups to the canvas',
    CLEAR: 'CLEAR — clear selection',
};

export function commandHelp(command?: string): string {
    if (!command) return COMMAND_NAMES.join(' · ');
    return HELP[command.toUpperCase()] ?? `HELP: unknown command ${command.toUpperCase()}`;
}
