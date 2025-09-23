export function escapeHtml(input: unknown): string {
    if (input === undefined || input === null) {
        return '';
    }

    const text = typeof input === 'string' ? input : String(input);

    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeLanguageId(languageId: string): string {
    const sanitized = languageId.trim().replace(/[^0-9A-Za-z_+.#-]+/g, '-');
    return sanitized || 'text';
}

export function createDiv(className: string, content: string): string {
    if (!content.trim()) {
        return '';
    }

    return `<div class="${className}">${content}</div>`;
}

export function renderParagraph(text: string): string {
    return createDiv('message-paragraph', escapeHtml(text));
}

const blockIndicators = ['<pre', '<table', '<ol', '<ul', '<h1', '<h2', '<h3', '<blockquote', '<hr'];

function ensureParagraphWrapper(content: string): string {
    if (blockIndicators.some(indicator => content.includes(indicator))) {
        return content;
    }

    return createDiv('message-paragraph', content);
}

export function renderValueAsHtml(value: string, languageId?: string): string {
    if (languageId && !['markdown', 'plaintext', 'text'].includes(languageId)) {
        const sanitizedLanguage = escapeLanguageId(languageId);
        return `<pre><code class="language-${sanitizedLanguage}">${escapeHtml(value)}</code></pre>`;
    }

    const formatted = formatCodeContent(value);
    return ensureParagraphWrapper(formatted);
}

export function formatStructuredOutput(value: unknown): string {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return '';
        }
        return `<pre class="message-pre">${escapeHtml(trimmed)}</pre>`;
    }

    return formatJsonValue(value);
}

export function formatStructuredValue(value: unknown): string {
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

export function renderDetailRow(label: string, value: unknown): string {
    const formatted = formatStructuredValue(value);
    if (!formatted) {
        return '';
    }

    return `<div class="detail-grid"><div class="detail-key">${escapeHtml(label)}</div><div class="detail-value">${formatted}</div></div>`;
}

export function renderDetailRows(rows: Array<[string, unknown]>): string | undefined {
    const renderedRows = rows
        .map(([label, value]) => renderDetailRow(label, value))
        .filter((row): row is string => Boolean(row));

    if (renderedRows.length === 0) {
        return undefined;
    }

    return renderedRows.join('');
}

export function wrapMetadataSection(title: string, body: string): string {
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

export function formatJsonValue(value: unknown): string {
    let json: string;
    try {
        json = JSON.stringify(value, null, 2);
    } catch (error) {
        json = `<<Serialization failed: ${error instanceof Error ? error.message : String(error)}>>`;
    }

    return `<div class="raw-json"><pre class="message-pre"><code class="language-json">${escapeHtml(json)}</code></pre></div>`;
}

export function formatCodeContent(text: string): string {
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

export function formatTimestamp(value: number | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    return date.toLocaleString();
}
