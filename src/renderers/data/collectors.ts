import type { ChatCommandRun, ChatFileChange, ChatMessage, ChatToolInvocation } from '../../types';
import { stableSerialize } from './serialization';

export function collectCommandRuns(request: ChatMessage): ChatCommandRun[] {
    const entries: unknown[] = [];

    if (Array.isArray(request.commandRuns)) {
        entries.push(...request.commandRuns);
    }

    (request.response ?? []).forEach(item => {
        if (!item) {
            return;
        }

        if (Array.isArray(item.commandRuns)) {
            entries.push(...item.commandRuns);
        }

        const candidate: Partial<ChatCommandRun> & Record<string, unknown> = item as unknown as Record<string, unknown>;
        if (
            typeof candidate.command === 'string' ||
            typeof candidate.title === 'string' ||
            candidate.arguments !== undefined ||
            candidate.result !== undefined ||
            candidate.output !== undefined ||
            typeof candidate.status === 'string' ||
            typeof candidate.timestamp === 'number'
        ) {
            entries.push({
                title: typeof candidate.title === 'string' ? candidate.title : undefined,
                command: typeof candidate.command === 'string' ? candidate.command : undefined,
                arguments: candidate.arguments,
                result: candidate.result,
                status: typeof candidate.status === 'string' ? candidate.status : undefined,
                output: typeof candidate.output === 'string' ? candidate.output : undefined,
                timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : undefined
            } satisfies ChatCommandRun);
        }
    });

    return collectNormalizedItems(entries, normalizeCommandRun);
}

export function collectToolInvocations(request: ChatMessage): ChatToolInvocation[] {
    const entries: unknown[] = [];

    if (Array.isArray(request.toolInvocations)) {
        entries.push(...request.toolInvocations);
    }

    (request.response ?? []).forEach(item => {
        if (!item) {
            return;
        }

        if (Array.isArray(item.toolInvocations)) {
            entries.push(...item.toolInvocations);
        } else if (item.toolInvocations && typeof item.toolInvocations === 'object') {
            entries.push(item.toolInvocations);
        }

        const candidate = item as unknown as Record<string, unknown>;
        if (typeof candidate.toolName === 'string' || typeof candidate.toolId === 'string') {
            entries.push({
                toolName: typeof candidate.toolName === 'string'
                    ? (candidate.toolName as string)
                    : (typeof candidate.toolId === 'string' ? (candidate.toolId as string) : undefined),
                name: typeof candidate.name === 'string' ? (candidate.name as string) : undefined,
                status: typeof candidate.status === 'string' ? (candidate.status as string) : undefined,
                input: candidate.input ?? candidate.arguments,
                result: candidate.result,
                output: candidate.output,
                error: candidate.error,
                metadata: typeof candidate.metadata === 'object' && candidate.metadata !== null
                    ? (candidate.metadata as Record<string, unknown>)
                    : undefined,
                startTime: typeof candidate.startTime === 'number' ? (candidate.startTime as number) : undefined,
                endTime: typeof candidate.endTime === 'number' ? (candidate.endTime as number) : undefined
            } satisfies ChatToolInvocation);
        }
    });

    return collectNormalizedItems(entries, normalizeToolInvocation);
}

export function collectFileChanges(request: ChatMessage): ChatFileChange[] {
    const entries: unknown[] = [];

    if (Array.isArray(request.fileChanges)) {
        entries.push(...request.fileChanges);
    }

    (request.response ?? []).forEach(item => {
        if (!item) {
            return;
        }

        if (Array.isArray(item.fileChanges)) {
            entries.push(...item.fileChanges);
        }

        const responseEdits = (item as unknown as { fileEdits?: unknown }).fileEdits;
        if (Array.isArray(responseEdits)) {
            entries.push(...(responseEdits as ChatFileChange[]));
        }

        if (Array.isArray(item.files)) {
            entries.push(...item.files);
        }

        const candidate = item as unknown as Record<string, unknown>;
        if (typeof candidate.path === 'string' || typeof candidate.diff === 'string' || typeof candidate.content === 'string') {
            entries.push({
                path: typeof candidate.path === 'string' ? (candidate.path as string) : undefined,
                diff: typeof candidate.diff === 'string' ? (candidate.diff as string) : undefined,
                content: typeof candidate.content === 'string' ? (candidate.content as string) : undefined,
                explanation: typeof candidate.explanation === 'string' ? (candidate.explanation as string) : undefined,
                languageId: typeof candidate.languageId === 'string' ? (candidate.languageId as string) : undefined,
                uri: typeof candidate.uri === 'string' ? (candidate.uri as string) : undefined
            } satisfies ChatFileChange);
        }
    });

    return collectNormalizedItems(entries, normalizeFileChange, mergeFileChanges);
}

type NormalizedEntry<T> = {
    item: T;
    key?: string | undefined;
};

export function collectNormalizedItems<T>(
    values: Iterable<unknown>,
    normalizer: (value: unknown) => NormalizedEntry<T> | undefined,
    merger: (existing: T, incoming: T) => T = mergeDefinedFields
): T[] {
    const results: T[] = [];
    const indices = new Map<string, number>();

    for (const value of values) {
        const normalized = normalizer(value);
        if (!normalized) {
            continue;
        }

        const { item, key } = normalized;
        if (!key) {
            results.push(item);
            continue;
        }

        const existingIndex = indices.get(key);
        if (existingIndex === undefined) {
            indices.set(key, results.length);
            results.push(item);
        } else {
            results[existingIndex] = merger(results[existingIndex], item);
        }
    }

    return results;
}

function normalizeCommandRun(value: unknown): NormalizedEntry<ChatCommandRun> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const run = value as Record<string, unknown>;
    const normalized: ChatCommandRun = {
        title: typeof run.title === 'string' ? run.title : undefined,
        command: typeof run.command === 'string' ? run.command : undefined,
        arguments: run.arguments,
        result: run.result,
        status: typeof run.status === 'string' ? run.status : undefined,
        output: typeof run.output === 'string' ? run.output : undefined,
        timestamp: typeof run.timestamp === 'number' ? run.timestamp : undefined
    };

    if (
        normalized.title === undefined &&
        normalized.command === undefined &&
        normalized.arguments === undefined &&
        normalized.result === undefined &&
        normalized.status === undefined &&
        normalized.output === undefined &&
        normalized.timestamp === undefined
    ) {
        return undefined;
    }

    return {
        item: normalized,
        key: stableSerialize({
            title: normalized.title,
            command: normalized.command,
            arguments: normalized.arguments,
            result: normalized.result,
            status: normalized.status,
            output: normalized.output,
            timestamp: normalized.timestamp
        })
    };
}

function normalizeToolInvocation(value: unknown): NormalizedEntry<ChatToolInvocation> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const invocation = value as Record<string, unknown>;
    const normalized: ChatToolInvocation = {
        toolName: typeof invocation.toolName === 'string' ? invocation.toolName : undefined,
        name: typeof invocation.name === 'string' ? invocation.name : undefined,
        status: typeof invocation.status === 'string' ? invocation.status : undefined,
        input: invocation.input ?? invocation.arguments,
        result: invocation.result,
        output: invocation.output,
        error: invocation.error,
        metadata: typeof invocation.metadata === 'object' && invocation.metadata !== null
            ? (invocation.metadata as Record<string, unknown>)
            : undefined,
        startTime: typeof invocation.startTime === 'number' ? invocation.startTime : undefined,
        endTime: typeof invocation.endTime === 'number' ? invocation.endTime : undefined
    };

    if (
        normalized.toolName === undefined &&
        normalized.name === undefined &&
        normalized.status === undefined &&
        normalized.input === undefined &&
        normalized.result === undefined &&
        normalized.output === undefined &&
        normalized.error === undefined &&
        normalized.metadata === undefined &&
        normalized.startTime === undefined &&
        normalized.endTime === undefined
    ) {
        return undefined;
    }

    return {
        item: normalized,
        key: stableSerialize({
            toolName: normalized.toolName,
            name: normalized.name,
            status: normalized.status,
            input: normalized.input,
            result: normalized.result,
            output: normalized.output,
            error: normalized.error,
            metadata: normalized.metadata,
            startTime: normalized.startTime,
            endTime: normalized.endTime
        })
    };
}

function normalizeFileChange(value: unknown): NormalizedEntry<ChatFileChange> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const change = value as Record<string, unknown>;
    const normalized: ChatFileChange = {
        path: typeof change.path === 'string' ? change.path : undefined,
        diff: typeof change.diff === 'string' ? change.diff : undefined,
        content: typeof change.content === 'string' ? change.content : undefined,
        explanation: typeof change.explanation === 'string' ? change.explanation : undefined,
        languageId: typeof change.languageId === 'string' ? change.languageId : undefined,
        uri: typeof change.uri === 'string' ? change.uri : undefined
    };

    if (
        normalized.path === undefined &&
        normalized.diff === undefined &&
        normalized.content === undefined &&
        normalized.explanation === undefined &&
        normalized.languageId === undefined &&
        normalized.uri === undefined
    ) {
        return undefined;
    }

    return {
        item: normalized,
        key: stableSerialize({
            path: normalized.path,
            diff: normalized.diff,
            content: normalized.content,
            explanation: normalized.explanation,
            languageId: normalized.languageId,
            uri: normalized.uri
        })
    };
}

function mergeFileChanges(existing: ChatFileChange, incoming: ChatFileChange): ChatFileChange {
    const merged = mergeDefinedFields(existing, incoming);

    const existingDiff = existing.diff ?? '';
    const incomingDiff = incoming.diff ?? '';
    if (incomingDiff && !existingDiff) {
        merged.diff = incomingDiff;
    }

    const existingContent = existing.content ?? '';
    const incomingContent = incoming.content ?? '';
    if (incomingContent && !existingContent) {
        merged.content = incomingContent;
    }

    return merged;
}

export function mergeDefinedFields<T>(existing: T, incoming: T): T {
    if (!isRecord(existing) || !isRecord(incoming)) {
        return incoming;
    }

    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        if (value !== undefined) {
            const current = merged[key];
            if (current === undefined || current === '' || current === null) {
                merged[key] = value;
            }
        }
    }

    return merged as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonSafely(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}
