import type { ChatMessage, ChatSessionData } from '../types';
import { buildAssistantSections } from './sections/assistantSections';
import { escapeHtml, renderParagraph } from './utils/html';

export function generateChatHTML(
    sessionData: { data: ChatSessionData },
    cssContent: string,
    responderName: string = 'Copilot'
): string {
    const { data } = sessionData;
    const messagesHtml = data.requests
        .map((message: ChatMessage) => {
            if (message.message?.text) {
                return renderUserMessage(message, data.requesterUsername);
            } else if (message.response) {
                return renderAssistantMessage(message, responderName);
            }
            return null;
        })
        .filter(Boolean)
        .join('\n');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat History</title>
            <style>
                ${cssContent}
            </style>
        </head>
        <body>
            <div class="interactive-list">
                ${messagesHtml}
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
        <div class="interactive-item-container interactive-request">
            <div class="header">
                <div class="user">
                    <div class="avatar-container">
                        <div class="avatar user-avatar">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                                <path d="M16 7.992C16 3.58 12.416 0 8 0S0 3.58 0 7.992c0 2.43 1.104 4.62 2.832 6.09.016.016.032.016.032.032.144.112.288.224.448.336.08.048.144.111.224.175A7.98 7.98 0 0 0 8.016 16a7.98 7.98 0 0 0 4.48-1.375c.08-.048.144-.111.224-.16.144-.111.304-.223.448-.335.016-.016.032-.016.032-.032 1.696-1.487 2.8-3.676 2.8-6.106zm-8 7.001c-1.504 0-2.88-.48-4.016-1.279-.128.048-.255.08-.383.128a4.17 4.17 0 0 1 .416-.991c.176-.304.384-.576.64-.816.24-.24.528-.463.816-.639.304-.176.624-.304.976-.4A4.15 4.15 0 0 1 8 10.342a4.185 4.185 0 0 1 2.928 1.166c.368.368.656.8.864 1.295.112.288.192.592.24.911A7.03 7.03 0 0 1 8 15.993zm4.928-2.272A5.03 5.03 0 0 0 8 9.297c-1.311 0-2.513.541-3.584 1.406-.08-.48-.336-.927-.65-1.25a2.97 2.97 0 0 0-.88-.687 3.99 3.99 0 0 1-.04-5.483c.48-.48 1.072-.816 1.712-1.02C4.9 2.034 5.472 1.917 6.08 1.917a3.99 3.99 0 0 1 3.904 3.304c.016.111.048.209.048.329 0 .662-.336 1.243-.864 1.59-.528.346-.864.927-.864 1.589 0 .662.336 1.243.864 1.59.528.346.864.927.864 1.589z"/>
                            </svg>
                        </div>
                    </div>
                    <div class="username">${escapeHtml(requesterName)}</div>
                </div>
            </div>
            <div class="value">
                <div class="rendered-markdown">
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
        <div class="interactive-item-container interactive-response">
            <div class="header">
                <div class="user">
                    <div class="avatar-container">
                        <div class="avatar copilot-avatar">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                            </svg>
                        </div>
                    </div>
                    <div class="username">${escapeHtml(responderName)}</div>
                </div>
            </div>
            <div class="value">
                <div class="rendered-markdown">
                    ${sections.join('')}
                </div>
            </div>
        </div>
    `;
}
