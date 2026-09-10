export const COMMAND_NAMES = ['SELECT', 'REVEAL', 'FIT', 'CLEAR', 'HELP'] as const;

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
