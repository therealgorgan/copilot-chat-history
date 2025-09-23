import type { ChatMessage } from '../../types';
import { parseJsonSafely } from '../data/collectors';
import {
    createDiv,
    formatJsonValue,
    renderDetailRows,
    renderValueAsHtml
} from '../utils/html';

export function renderAssistantTextSection(request: ChatMessage): string | undefined {
    const assistantTextItems = renderResponseItems(request.response ?? []);
    if (assistantTextItems.length === 0) {
        return undefined;
    }

    return createDiv('message-markdown', assistantTextItems.join(''));
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
            fragments.push(renderValueAsHtml(primitiveText, (candidate.languageId as string | undefined)));
            return;
        }

        if (Array.isArray((item as unknown as { values?: unknown }).values)) {
            const { values } = item as unknown as { values: unknown[] };
            const renderedValues = values
                .map(value => {
                    if (typeof value === 'string') {
                        return renderValueAsHtml(value, (candidate.languageId as string | undefined));
                    }
                    return undefined;
                })
                .filter((value): value is string => Boolean(value));

            fragments.push(...renderedValues);
            return;
        }

        if (candidate.mimeType === 'application/json' && typeof candidate.value === 'string') {
            fragments.push(formatJsonValue(parseJsonSafely(candidate.value)));
            return;
        }

        const rows: Array<[string, unknown]> = [];
        if (candidate.title) {
            rows.push(['Title', candidate.title]);
        }
        if (candidate.status) {
            rows.push(['Status', candidate.status]);
        }
        if (candidate.output !== undefined) {
            rows.push(['Output', candidate.output]);
        }
        if (candidate.result !== undefined) {
            rows.push(['Result', candidate.result]);
        }

        const details = renderDetailRows(rows);
        if (details) {
            fragments.push(createDiv('detail-block', details));
        }
    });

    return fragments;
}
