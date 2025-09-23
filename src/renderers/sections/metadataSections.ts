import type { ChatCommandRun, ChatFileChange, ChatMessage, ChatToolInvocation } from '../../types';
import {
    createDiv,
    escapeHtml,
    formatStructuredOutput,
    formatStructuredValue,
    formatTimestamp,
    renderDetailRows,
    renderDetailRow,
    renderParagraph,
    renderValueAsHtml,
    wrapMetadataSection
} from '../utils/html';

export function renderFileChangesSection(changes: ChatFileChange[]): string | undefined {
    if (changes.length === 0) {
        return undefined;
    }

    const blocks = changes
        .map(change => {
            const parts: string[] = [];
            const header = change.path || change.uri;
            if (header) {
                parts.push(createDiv('detail-title', escapeHtml(header)));
            }

            const rows: Array<[string, unknown]> = [];
            if (change.explanation) {
                parts.push(renderParagraph(change.explanation));
            }

            if (change.uri && change.uri !== change.path) {
                rows.push(['URI', change.uri]);
            }

            if (rows.length > 0) {
                const renderedRows = renderDetailRows(rows);
                if (renderedRows) {
                    parts.push(renderedRows);
                }
            }

            const codeContent = change.diff ?? change.content;
            if (codeContent) {
                const languageId = change.languageId || (change.diff ? 'diff' : undefined);
                parts.push(renderValueAsHtml(codeContent, languageId));
            }

            return createDiv('metadata-block', parts.join(''));
        })
        .filter((block): block is string => Boolean(block && block.trim()));

    if (blocks.length === 0) {
        return undefined;
    }

    return wrapMetadataSection('File changes', blocks.join(''));
}

export function renderCommandRunsSection(runs: ChatCommandRun[]): string | undefined {
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
            const header = title ? createDiv('detail-title', escapeHtml(title)) : '';
            return createDiv('detail-block', `${header}${details ?? ''}${output}`);
        })
        .filter((entry): entry is string => Boolean(entry && entry.trim()));

    if (entries.length === 0) {
        return undefined;
    }

    return wrapMetadataSection('Executed commands', entries.join(''));
}

export function renderToolInvocationsSection(invocations: ChatToolInvocation[]): string | undefined {
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
                body.push(createDiv('detail-title', escapeHtml(title)));
            }

            if (details) {
                body.push(details);
            }

            if (invocation.output !== undefined) {
                body.push(formatStructuredOutput(invocation.output));
            }

            if (invocation.error !== undefined) {
                body.push(renderDetailRow('Error', invocation.error));
            }

            const content = body.join('');
            if (!content.trim()) {
                return '';
            }

            return createDiv('detail-block', content);
        })
        .filter((entry): entry is string => Boolean(entry && entry.trim()));

    if (entries.length === 0) {
        return undefined;
    }

    return wrapMetadataSection('Tool invocations', entries.join(''));
}

export function renderAdditionalDataSection(request: ChatMessage): string | undefined {
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
