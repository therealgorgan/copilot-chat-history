import * as fs from 'fs';
import * as path from 'path';
import type {
    ChatCommandRun,
    ChatFileChange,
    ChatMessage,
    ChatSession,
    ChatSessionData,
    ChatToolInvocation
} from '../types';

export function generateChatHTML(sessionData: ChatSessionData, session: ChatSession): string {
    const messages = sessionData.requests || [];

    let messagesHtml = '';

    messages.forEach((request) => {
        const requesterName = sessionData.requesterUsername || 'User';
        const responderName = sessionData.responderUsername || 'GitHub Copilot';

        const userMessageHtml = renderUserMessage(request, requesterName);
        if (userMessageHtml) {
            messagesHtml += userMessageHtml;
        }

        const assistantMessageHtml = renderAssistantMessage(request, responderName);
        if (assistantMessageHtml) {
            messagesHtml += assistantMessageHtml;
        }
    });

    const styles = getChatStyles();

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat Session</title>
            <style>${styles}</style>
        </head>
        <body>
            <div class="chat-container">
                <div class="chat-header">
                    <h1 class="chat-title">${escapeHtml(session.customTitle || 'Chat Session')}</h1>
                    <div class="chat-meta">
                        Workspace: ${escapeHtml(session.workspaceName)} •
                        Messages: ${messages.length} •
                        Last modified: ${session.lastModified.toLocaleString()}
                    </div>
                </div>

                <div class="messages">
                    ${messages.length > 0 ? messagesHtml : '<div class="empty-chat">No messages in this chat session</div>'}
                </div>
            </div>
        </body>
        </html>
    `;
}

function renderUserMessage(request: ChatMessage, requesterName: string): string | undefined {
    const userText = request.message?.text;
    if (!userText || userText.trim() === '') {
        return undefined;
    }

    return `
        <div class="message user-message">
            <div class="avatar user-avatar">
                <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                    <path d="M16 7.992C16 3.58 12.416 0 8 0S0 3.58 0 7.992c0 2.43 1.104 4.62 2.832 6.09.016.016.032.016.032.032.144.112.288.224.448.336.08.048.144.111.224.175A7.98 7.98 0 0 0 8.016 16a7.98 7.98 0 0 0 4.48-1.375c.08-.048.144-.111.224-.16.144-.111.304-.223.448-.335.016-.016.032-.016.032-.032 1.696-1.487 2.8-3.676 2.8-6.106zm-8 7.001c-1.504 0-2.88-.48-4.016-1.279-.128.048-.255.08-.383.128a4.17 4.17 0 0 1 .416-.991c.176-.304.384-.576.64-.816.24-.24.528-.463.816-.639.304-.176.624-.304.976-.4A4.15 4.15 0 0 1 8 10.342a4.185 4.185 0 0 1 2.928 1.166c.368.368.656.8.864 1.295.112.288.192.592.24.911A7.03 7.03 0 0 1 8 15.993zm4.928-2.272A5.03 5.03 0 0 0 8 9.297c-1.311 0-2.513.541-3.584 1.406-.08-.48-.336-.927-.65-1.25a2.97 2.97 0 0 0-.88-.687 3.99 3.99 0 0 1-.04-5.483c.48-.48 1.072-.816 1.712-1.02C4.9 2.034 5.472 1.917 6.08 1.917a3.99 3.99 0 0 1 3.904 3.304c.016.111.048.209.048.329 0 .662-.336 1.243-.864 1.59-.528.346-.864.927-.864 1.589 0 .662.336 1.243.864 1.59.528.346.864.927.864 1.589z"/>
                </svg>
            </div>
            <div class="message-body">
                <div class="message-header">
                    <div class="username">${escapeHtml(requesterName)}</div>
                </div>
                <div class="message-content">
                    ${renderParagraph(userText)}
                </div>
            </div>
        </div>
    `;
}

function renderAssistantMessage(request: ChatMessage, responderName: string): string | undefined {
    const sections = buildAssistantSections(request);
    if (sections.length === 0) {
        return undefined;
    }

    return `
        <div class="message copilot-message">
            <div class="avatar copilot-avatar">
                <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49 0-.5-.17-.82-.37-.98-1.23-.14-2.52-.6-3.49-1.42-.79-.68-1.3-1.6-1.3-2.71 0-2.04 1.64-3.68 3.68-3.68.89 0 1.72.33 2.38.94.66-.61 1.49-.94 2.38-.94 2.04 0 3.68 1.64 3.68 3.68 0 1.11-.51 2.03-1.3 2.71-.97.82-2.26 1.28-3.49 1.42-.2.16-.37.48-.37.98 0 .67-.01 1.3-.01 1.49 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                </svg>
            </div>
            <div class="message-body">
                <div class="message-header">
                    <div class="username">${escapeHtml(responderName)}</div>
                </div>
                <div class="message-content">
                    ${sections.join('')}
                </div>
            </div>
        </div>
    `;
}

function buildAssistantSections(request: ChatMessage): string[] {
    const sections: string[] = [];

    const textSection = renderAssistantTextSection(request);
    if (textSection) {
        sections.push(textSection);
    }

    const fileSection = renderFileChangesSection(collectFileChanges(request));
    if (fileSection) {
        sections.push(fileSection);
    }

    const commandsSection = renderCommandRunsSection(collectCommandRuns(request));
    if (commandsSection) {
        sections.push(commandsSection);
    }

    const toolsSection = renderToolInvocationsSection(collectToolInvocations(request));
    if (toolsSection) {
        sections.push(toolsSection);
    }

    const additionalDataSection = renderAdditionalDataSection(request);
    if (additionalDataSection) {
        sections.push(additionalDataSection);
    }

    return sections;
}

function renderAssistantTextSection(request: ChatMessage): string | undefined {
    const assistantTextItems = renderResponseItems(request.response ?? []);
    if (assistantTextItems.length === 0) {
        return undefined;
    }

    return `<div class="message-markdown">${assistantTextItems.join('')}</div>`;
}

function renderResponseItems(items: ChatMessage['response']): string[] {
    if (!items) {
        return [];
    }

    const fragments: string[] = [];
    items.forEach(item => {
        if (!item) {
            return;
        }

        if (typeof (item as unknown) === 'string') {
            const stringItem = item as unknown as string;
            if (stringItem.trim()) {
                fragments.push(renderValueAsHtml(stringItem));
            }
            return;
        }

        const candidate = item as Record<string, unknown>;
        const primitiveText =
            typeof candidate.value === 'string'
                ? candidate.value
                : typeof candidate.text === 'string'
                    ? candidate.text
                    : typeof candidate.message === 'string'
                        ? candidate.message
                        : undefined;
        if (primitiveText && primitiveText.trim() !== '') {
            fragments.push(renderValueAsHtml(primitiveText, item.languageId));
            return;
        }

        if (Array.isArray((item as unknown as { values?: unknown }).values)) {
            const values = (item as unknown as { values: unknown[] }).values;
            const renderedValues = values
                .map(value => {
                    if (typeof value === 'string') {
                        return renderValueAsHtml(value, item.languageId);
                    }
                    return undefined;
                })
                .filter((value): value is string => Boolean(value));

            fragments.push(...renderedValues);
            return;
        }

        if (item.mimeType === 'application/json' && typeof item.value === 'string') {
            fragments.push(formatJsonValue(parseJsonSafely(item.value)));
            return;
        }

        const rows: Array<[string, unknown]> = [];
        if (item.title) {
            rows.push(['Title', item.title]);
        }
        if (item.status) {
            rows.push(['Status', item.status]);
        }
        if (item.output !== undefined) {
            rows.push(['Output', item.output]);
        }
        if (item.result !== undefined) {
            rows.push(['Result', item.result]);
        }

        const details = renderDetailRows(rows);
        if (details) {
            fragments.push(`<div class="detail-block">${details}</div>`);
        }
    });

    return fragments;
}

function collectCommandRuns(request: ChatMessage): ChatCommandRun[] {
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

function collectToolInvocations(request: ChatMessage): ChatToolInvocation[] {
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

function collectFileChanges(request: ChatMessage): ChatFileChange[] {
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

function normalizeCommandRun(value: unknown): NormalizedEntry<ChatCommandRun> | undefined {
    if (!value || typeof value !== 'object') {
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
    if (!value || typeof value !== 'object') {
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
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const change = value as Record<string, unknown>;
    const normalized: ChatFileChange = {
        path: typeof change.path === 'string' ? change.path : undefined,
        uri: typeof change.uri === 'string' ? change.uri : undefined,
        diff: typeof change.diff === 'string' ? change.diff : undefined,
        content: typeof change.content === 'string' ? change.content : undefined,
        explanation: typeof change.explanation === 'string' ? change.explanation : undefined,
        languageId: typeof change.languageId === 'string' ? change.languageId : undefined
    };

    if (!normalized.diff && !normalized.content && !normalized.explanation) {
        return undefined;
    }

    return {
        item: normalized,
        key: stableSerialize({
            path: normalized.path,
            uri: normalized.uri,
            diff: normalized.diff,
            content: normalized.content,
            explanation: normalized.explanation,
            languageId: normalized.languageId
        })
    };
}

function mergeFileChanges(existing: ChatFileChange, incoming: ChatFileChange): ChatFileChange {
    const merged = { ...existing };

    const assignIfUseful = <K extends keyof ChatFileChange>(key: K) => {
        const nextValue = incoming[key];
        if (nextValue === undefined) {
            return;
        }

        const currentValue = merged[key];
        if (currentValue === undefined || currentValue === '' || currentValue === null) {
            merged[key] = nextValue;
        }
    };

    assignIfUseful('path');
    assignIfUseful('uri');
    assignIfUseful('diff');
    assignIfUseful('content');
    assignIfUseful('explanation');
    assignIfUseful('languageId');

    return merged;
}

function renderFileChangesSection(changes: ChatFileChange[]): string | undefined {
    if (changes.length === 0) {
        return undefined;
    }

    const blocks = changes.map((change, index) => {
        const parts: string[] = [];
        const label = change.path || change.uri || `Change ${index + 1}`;
        parts.push(`<div class="metadata-subtitle">${escapeHtml(label)}</div>`);

        if (change.explanation) {
            parts.push(renderParagraph(change.explanation));
        }

        const codeContent = change.diff ?? change.content;
        if (codeContent) {
            const languageId = change.languageId || (change.diff ? 'diff' : undefined);
            parts.push(renderValueAsHtml(codeContent, languageId));
        }

        return `<div class="metadata-block">${parts.join('')}</div>`;
    });

    return wrapMetadataSection('File changes', blocks.join(''));
}

function renderCommandRunsSection(runs: ChatCommandRun[]): string | undefined {
    const entries = runs
        .map((run, index) => {
            const rows: Array<[string, unknown]> = [];
            if (run.command) {
                rows.push(['Command', run.command]);
            }
            if (run.arguments !== undefined) {
                rows.push(['Arguments', run.arguments]);
            }
            if (run.status) {
                rows.push(['Status', run.status]);
            }
            if (run.result !== undefined) {
                rows.push(['Result', run.result]);
            }
            if (run.timestamp !== undefined) {
                const timestamp = formatTimestamp(run.timestamp);
                if (timestamp) {
                    rows.push(['Timestamp', timestamp]);
                }
            }

            const details = renderDetailRows(rows);
            const output = typeof run.output === 'string' && run.output.trim()
                ? `<pre class="message-pre">${escapeHtml(run.output)}</pre>`
                : '';

            if (!details && !output) {
                return '';
            }

            const title = run.title || run.command || `Command ${index + 1}`;
            return `<div class="detail-block">${title ? `<div class="detail-title">${escapeHtml(title)}</div>` : ''}${details}${output}</div>`;
        })
        .filter((entry): entry is string => Boolean(entry && entry.trim()));

    if (entries.length === 0) {
        return undefined;
    }

    return wrapMetadataSection('Executed commands', entries.join(''));
}

function renderToolInvocationsSection(invocations: ChatToolInvocation[]): string | undefined {
    const entries = invocations
        .map((invocation, index) => {
            const rows: Array<[string, unknown]> = [];
            const title = invocation.toolName || invocation.name || `Tool invocation ${index + 1}`;

            if (invocation.toolName && invocation.name && invocation.toolName !== invocation.name) {
                rows.push(['Name', invocation.name]);
            }

            if (invocation.status) {
                rows.push(['Status', invocation.status]);
            }

            if (invocation.startTime !== undefined) {
                const started = formatTimestamp(invocation.startTime);
                if (started) {
                    rows.push(['Started', started]);
                }
            }

            if (invocation.endTime !== undefined) {
                const ended = formatTimestamp(invocation.endTime);
                if (ended) {
                    rows.push(['Completed', ended]);
                }
            }

            if (invocation.input !== undefined) {
                rows.push(['Input', invocation.input]);
            }

            if (invocation.result !== undefined) {
                rows.push(['Result', invocation.result]);
            }

            if (invocation.metadata !== undefined) {
                rows.push(['Metadata', invocation.metadata]);
            }

            const details = renderDetailRows(rows);

            const body: string[] = [];
            if (title) {
                body.push(`<div class="detail-title">${escapeHtml(title)}</div>`);
            }

            if (details) {
                body.push(details);
            }

            if (invocation.output !== undefined) {
                body.push(formatStructuredOutput(invocation.output));
            }

            if (invocation.error !== undefined) {
                body.push(`<div class="detail-grid"><div class="detail-key">Error</div><div class="detail-value">${formatStructuredValue(invocation.error)}</div></div>`);
            }

            if (body.length === 1 && body[0] === '') {
                return '';
            }

            return `<div class="detail-block">${body.join('')}</div>`;
        })
        .filter((entry): entry is string => Boolean(entry && entry.trim()));

    if (entries.length === 0) {
        return undefined;
    }

    return wrapMetadataSection('Tool invocations', entries.join(''));
}

function renderAdditionalDataSection(request: ChatMessage): string | undefined {
    const extraSections: string[] = [];
    const requestKnownKeys = new Set(['message', 'response', 'commandRuns', 'toolInvocations', 'fileChanges', 'timestamp']);
    const requestExtra = extractAdditionalData(request, requestKnownKeys);
    if (requestExtra) {
        extraSections.push(`<details><summary>Request metadata</summary>${requestExtra}</details>`);
    }

    const responseKnownKeys = new Set([
        'type',
        'kind',
        'mimeType',
        'languageId',
        'value',
        'title',
        'command',
        'arguments',
        'result',
        'output',
        'status',
        'commandRuns',
        'toolInvocations',
        'fileChanges',
        'fileEdits',
        'files',
        'path',
        'uri',
        'diff',
        'content',
        'explanation'
    ]);

    (request.response ?? []).forEach((item, index) => {
        const extra = extractAdditionalData(item, responseKnownKeys);
        if (extra) {
            extraSections.push(`<details><summary>Response item ${index + 1}</summary>${extra}</details>`);
        }
    });

    if (extraSections.length === 0) {
        return undefined;
    }

    return wrapMetadataSection('Additional data', extraSections.join(''));
}

function extractAdditionalData(value: unknown, knownKeys: Set<string>): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const entries = Object.entries(value as Record<string, unknown>).filter(([key, itemValue]) => {
        return !knownKeys.has(key) && itemValue !== undefined;
    });

    if (entries.length === 0) {
        return undefined;
    }

    const rows = entries.map(([key, itemValue]) => {
        return `<div class="detail-grid"><div class="detail-key">${escapeHtml(key)}</div><div class="detail-value">${formatStructuredValue(itemValue)}</div></div>`;
    });

    return rows.join('');
}

function renderDetailRows(rows: Array<[string, unknown]>): string | undefined {
    if (rows.length === 0) {
        return undefined;
    }

    const renderedRows = rows
        .map(([label, value]) => {
            if (value === undefined) {
                return '';
            }

            const formatted = formatStructuredValue(value);
            if (!formatted) {
                return '';
            }

            return `<div class="detail-grid"><div class="detail-key">${escapeHtml(label)}</div><div class="detail-value">${formatted}</div></div>`;
        })
        .filter((row): row is string => Boolean(row));

    if (renderedRows.length === 0) {
        return undefined;
    }

    return renderedRows.join('');
}

function wrapMetadataSection(title: string, body: string): string {
    if (!body.trim()) {
        return '';
    }

    return `
        <div class="metadata-section">
            <div class="metadata-title">${escapeHtml(title)}</div>
            ${body}
        </div>
    `;
}

function renderValueAsHtml(value: string, languageId?: string): string {
    if (languageId && !['markdown', 'plaintext', 'text'].includes(languageId)) {
        const sanitizedLanguage = escapeLanguageId(languageId);
        return `<pre><code class="language-${sanitizedLanguage}">${escapeHtml(value)}</code></pre>`;
    }

    const formatted = formatCodeContent(value);
    return ensureParagraphWrapper(formatted);
}

function formatStructuredOutput(value: unknown): string {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return '';
        }
        return `<pre class="message-pre">${escapeHtml(trimmed)}</pre>`;
    }

    return formatJsonValue(value);
}

function formatStructuredValue(value: unknown): string {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return '';
        }
        return escapeHtml(trimmed);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return escapeHtml(String(value));
    }

    if (value === null) {
        return '<em>null</em>';
    }

    return formatJsonValue(value);
}

function formatJsonValue(value: unknown): string {
    let json: string;
    try {
        json = JSON.stringify(value, null, 2);
    } catch (error) {
        json = `<<Serialization failed: ${error instanceof Error ? error.message : String(error)}>>`;
    }

    return `<div class="raw-json"><pre class="message-pre"><code class="language-json">${escapeHtml(json)}</code></pre></div>`;
}

function ensureParagraphWrapper(content: string): string {
    const blockIndicators = ['<pre', '<table', '<ol', '<ul', '<h1', '<h2', '<h3', '<blockquote', '<hr'];
    if (blockIndicators.some(indicator => content.includes(indicator))) {
        return content;
    }

    return `<div class="message-paragraph">${content}</div>`;
}

function renderParagraph(text: string): string {
    return `<div class="message-paragraph">${escapeHtml(text)}</div>`;
}

function formatCodeContent(text: string): string {
    let formatted = escapeHtml(text);

    formatted = formatted.replace(/````(\w*)\n?([\s\S]*?)````/g, (_match, lang, code) => {
        return `<pre><code class="language-${escapeLanguageId(lang)}">${escapeHtml(String(code).trim())}</code></pre>`;
    });

    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
        return `<pre><code class="language-${escapeLanguageId(lang)}">${escapeHtml(String(code).trim())}</code></pre>`;
    });

    formatted = formatted.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, '<em>$1</em>');
    formatted = formatted.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    formatted = formatted.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    formatted = formatted.replace(/^# (.*$)/gm, '<h1>$1</h1>');
    formatted = formatted.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');
    formatted = formatted.replace(/^\d+\.\s+(.*$)/gm, '<li>$1</li>');
    formatted = formatted.replace(/(<li>.*<\/li>)/gs, match => {
        if (!match.includes('<ol>')) {
            return '<ol>' + match + '</ol>';
        }
        return match;
    });
    formatted = formatted.replace(/^[\s]*[-*+]\s+(.*$)/gm, '<li>$1</li>');
    formatted = formatted.replace(/(<li>.*<\/li>)/gs, match => {
        if (!match.includes('<ul>') && !match.includes('<ol>')) {
            return '<ul>' + match + '</ul>';
        }
        return match;
    });
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    formatted = formatted.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
    formatted = formatted.replace(/^---$/gm, '<hr>');
    formatted = formatted.replace(/  \n/g, '<br>\n');
    formatted = formatted.replace(/\n\s*\n/g, '</p><p>');

    if (!formatted.startsWith('<') && formatted.trim() !== '') {
        formatted = '<p>' + formatted + '</p>';
    }

    formatted = formatted.replace(/<p>\s*<\/p>/g, '');

    return formatted;
}

function escapeLanguageId(languageId: string): string {
    const sanitized = languageId.trim().replace(/[^0-9A-Za-z_+.#-]+/g, '-');
    return sanitized || 'text';
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ensureStylesCached(): void {
    if (cachedStyles !== undefined) {
        return;
    }

    const stylesPath = path.resolve(__dirname, '..', '..', 'resources', 'chatStyles.css');
    try {
        cachedStyles = fs.readFileSync(stylesPath, 'utf8');
    } catch (error) {
        console.error('Failed to load chat styles from', stylesPath, error);
        cachedStyles = '';
    }
}

function getChatStyles(): string {
    ensureStylesCached();
    return cachedStyles ?? '';
}

let cachedStyles: string | undefined;

function formatTimestamp(value: number | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    return date.toLocaleString();
}

function collectNormalizedItems<T>(values: Iterable<unknown>, normalizer: (value: unknown) => NormalizedEntry<T> | undefined, merger: (existing: T, incoming: T) => T = mergeDefinedFields): T[] {
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

type NormalizedEntry<T> = {
    item: T;
    key?: string | undefined;
};

function mergeDefinedFields<T>(existing: T, incoming: T): T {
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

function parseJsonSafely(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function stableSerialize(value: unknown): string | undefined {
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
                return Object.keys(nested)
                    .sort()
                    .reduce<Record<string, unknown>>((acc, key) => {
                        acc[key] = (nested as Record<string, unknown>)[key];
                        return acc;
                    }, {});
            }
            return nested;
        });
    } catch {
        return undefined;
    }
}
