import type { ChatMessage, ChatSession, ChatSessionData } from '../types';

export function buildChatMarkdown(sessionData: ChatSessionData, session: ChatSession): string {
    const sections: string[] = [];
    sections.push(renderChatMetadata(sessionData, session));

    const messagesSection = renderChatMessages(sessionData);
    if (messagesSection) {
        sections.push(messagesSection);
    }

    return sections.join('\n\n');
}

export function sanitizeFileName(name: string): string {
    const sanitized = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'chat-session';
    const MAX_FILENAME_LENGTH = 255;
    return sanitized.length > MAX_FILENAME_LENGTH ? sanitized.substring(0, MAX_FILENAME_LENGTH) : sanitized;
}

function renderChatMetadata(sessionData: ChatSessionData, session: ChatSession): string {
    const title = escapeMarkdownInline(session.customTitle || `Chat Session ${session.id}`);
    const workspaceName = session.workspaceName || 'Unknown workspace';
    const workspaceLine = session.workspacePath
        ? `${workspaceName} (${session.workspacePath})`
        : workspaceName;
    const messageCount = session.messageCount ?? (sessionData.requests?.length ?? 0);
    const metadataLines: string[] = [
        `# ${title}`,
        '',
        `- **Workspace:** ${escapeMarkdownInline(workspaceLine)}`,
        `- **Messages:** ${messageCount.toString()}`
    ];

    const createdDate = formatDate(sessionData.creationDate);
    if (createdDate) {
        metadataLines.push(`- **Created:** ${escapeMarkdownInline(createdDate)}`);
    }

    const lastActivity = sessionData.lastMessageDate ?? session.lastModified.getTime();
    const lastActivityLabel = sessionData.lastMessageDate ? 'Last message' : 'Last modified';
    metadataLines.push(`- **${lastActivityLabel}:** ${escapeMarkdownInline(formatDate(lastActivity))}`);

    return metadataLines.join('\n');
}

function renderChatMessages(sessionData: ChatSessionData): string | undefined {
    const messages = sessionData.requests || [];
    if (messages.length === 0) {
        return '_No messages in this chat session._';
    }

    const requester = sessionData.requesterUsername || 'User';
    const responder = sessionData.responderUsername || 'GitHub Copilot';

    const blocks = messages
        .map((request, index) => renderChatMessageBlock(request, index, requester, responder))
        .filter((block): block is string => Boolean(block && block.trim()));

    return blocks.join('\n\n');
}

function renderChatMessageBlock(
    request: ChatMessage,
    index: number,
    requester: string,
    responder: string
): string | undefined {
    const lines: string[] = [];
    const messageNumber = index + 1;

    const userText = request.message?.text?.trim();
    if (userText) {
        lines.push(`## Message ${messageNumber} — ${escapeMarkdownInline(requester)}`);
        if (request.timestamp) {
            const formattedTimestamp = formatDate(request.timestamp);
            if (formattedTimestamp) {
                lines.push(`*${escapeMarkdownInline(formattedTimestamp)}*`);
            }
        }
        lines.push('');
        lines.push(escapeMarkdownMultiline(userText));
    }

    const responseText = request.response
        ?.map(response => response.value)
        .filter((value): value is string => Boolean(value && value.trim()))
        .join('\n\n');

    if (responseText) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(`### Response ${messageNumber} — ${escapeMarkdownInline(responder)}`);
        lines.push('');
        lines.push(escapeMarkdownMultiline(responseText.trim()));
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
}

function escapeMarkdownInline(text: string): string {
    return text.replace(/([\\`*_{}\[\]()#+\-!.>|])/g, '\\$1');
}

function escapeMarkdownMultiline(text: string): string {
    return text
        .split('\n')
        .map(line => {
            if (line.trim().startsWith('```')) {
                return line.replace(/`/g, '\\`');
            }
            return escapeMarkdownInline(line);
        })
        .join('\n');
}

function formatDate(value: number | Date | undefined): string {
    if (value === undefined) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
}
