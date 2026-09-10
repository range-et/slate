export const COMMAND_NAMES = [
    'SELECT', 'REVEAL', 'EDIT', 'FIT', 'CLEAR', 'STUB', 'INTENT', 'CONTRACT',
    'CONTEXT', 'UNCONTEXT', 'LOCK', 'REASSIGN', 'COMPILE', 'RECOMPILE', 'SAVE', 'HELP',
] as const;

export type HarnessCommand = {
    name: string;
    args: string[];
};

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
    SELECT: 'SELECT name|id|ALL|NONE',
    REVEAL: 'REVEAL unit — open its source',
    EDIT: 'EDIT unit — open its source for editing',
    STUB: 'STUB file.py|Class :: def name(arg: Type) -> Type :: intent',
    INTENT: 'INTENT unit :: text',
    CONTRACT: 'CONTRACT unit :: text',
    CONTEXT: 'CONTEXT consumer :: dependency',
    UNCONTEXT: 'UNCONTEXT consumer :: dependency',
    LOCK: 'LOCK unit ON|OFF',
    REASSIGN: 'REASSIGN top_level_unit :: target.py',
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
