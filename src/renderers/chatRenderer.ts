import type { ChatMessage, ChatSession, ChatSessionData } from '../types';
import { buildAssistantSections } from './sections/assistantSections';
import { getChatStyles } from './styles';
import { escapeHtml, renderParagraph } from './utils/html';

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
