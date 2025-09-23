import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type {
    ChatCommandRun,
    ChatFileChange,
    ChatMessage,
    ChatSession,
    ChatSessionData,
    ChatToolInvocation
} from './types';
import { buildChatMarkdown, sanitizeFileName } from './markdown/chatMarkdown';
import { showCentralizedError } from './utils/notifications';
import { loadSessionData, resolveAccessibleSessionFilePath, SessionFileError } from './utils/sessionFiles';

interface WorkspaceGroup {
    workspaceName: string;
    workspacePath?: string;
    sessions: ChatSession[];
}

function logSessionFileError(scope: string, error: SessionFileError): void {
    if (error.cause) {
        console.error(`${scope}: ${error.message}`, error.cause);
    } else {
        console.error(`${scope}: ${error.message}`);
    }
}

function handleSessionFileError(scope: string, error: SessionFileError): void {
    logSessionFileError(scope, error);
    showCentralizedError(error.message, error.context);
}

// Tree Data Provider для отображения истории чатов
class CopilotChatHistoryProvider implements vscode.TreeDataProvider<ChatSession | WorkspaceGroup> {
    private _onDidChangeTreeData: vscode.EventEmitter<ChatSession | WorkspaceGroup | undefined | null | void> = new vscode.EventEmitter<ChatSession | WorkspaceGroup | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ChatSession | WorkspaceGroup | undefined | null | void> = this._onDidChangeTreeData.event;
    private _searchFilter: string = '';

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setSearchFilter(filter: string): void {
        this._searchFilter = filter.toLowerCase();
        this.refresh();
    }

    clearFilter(): void {
        this._searchFilter = '';
        this.refresh();
    }

    private matchesFilter(session: ChatSession): boolean {
        if (!this._searchFilter) {
            return true;
        }
        
        const title = session.customTitle || 'Untitled Session';
        return title.toLowerCase().includes(this._searchFilter);
    }

    getTreeItem(element: ChatSession | WorkspaceGroup): vscode.TreeItem {
        if ('sessions' in element) {
            // Это группа workspace
            const isCurrentWorkspace = this.isCurrentWorkspace(element);
            const itemLabel = isCurrentWorkspace ? `$(star-full) ${element.workspaceName}` : element.workspaceName;
            const item = new vscode.TreeItem(itemLabel, vscode.TreeItemCollapsibleState.Collapsed);
            const sessionsDescription = `${element.sessions.length} sessions`;
            item.iconPath = new vscode.ThemeIcon(isCurrentWorkspace ? 'root-folder-opened' : 'folder');
            item.description = isCurrentWorkspace ? `Current • ${sessionsDescription}` : sessionsDescription;
            item.contextValue = 'workspaceGroup';
            item.id = `workspace-${element.workspaceName}`;
            // Добавляем resourceUri если есть путь к workspace
            if (element.workspacePath) {
                item.resourceUri = vscode.Uri.file(element.workspacePath);
            }
            if (isCurrentWorkspace) {
                item.tooltip = element.workspacePath
                    ? `${element.workspacePath}\nCurrent workspace`
                    : 'Current workspace';
            }
            console.log('Created workspace TreeItem:', item.label, 'contextValue:', item.contextValue);
            return item;
        } else {
            // Это отдельная сессия чата
            const displayName = element.customTitle || element.id;
            const item = new vscode.TreeItem(displayName, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('comment-discussion');
            item.description = `${element.messageCount} messages`;
            item.tooltip = `Last modified: ${element.lastModified.toLocaleString()}`;
            item.contextValue = 'chatSession';
            item.command = {
                command: 'copilotChatHistory.openChat',
                title: 'Open Chat',
                arguments: [element]
            };
            return item;
        }
    }

    getChildren(element?: ChatSession | WorkspaceGroup): Thenable<(ChatSession | WorkspaceGroup)[]> {
        if (!element) {
            // Root level - возвращаем группы workspace
            return Promise.resolve(this.getChatSessions());
        } else if ('sessions' in element) {
            // Возвращаем отфильтрованные сессии для данного workspace
            const filteredSessions = element.sessions.filter(session => this.matchesFilter(session));
            return Promise.resolve(filteredSessions);
        } else {
            // Leaf node - нет детей
            return Promise.resolve([]);
        }
    }

    private async getChatSessions(): Promise<WorkspaceGroup[]> {
        const chatSessions = await this.scanForChatSessions();
        
        // Группируем по workspace
        const workspaceMap = new Map<string, ChatSession[]>();
        
        chatSessions.forEach(session => {
            const existing = workspaceMap.get(session.workspaceName) || [];
            existing.push(session);
            workspaceMap.set(session.workspaceName, existing);
        });

        // Конвертируем в массив групп, исключая пустые после фильтрации
        const groups: WorkspaceGroup[] = [];
        workspaceMap.forEach((sessions, workspaceName) => {
            const filteredSessions = sessions.filter(session => this.matchesFilter(session));
            if (filteredSessions.length > 0) {
                // Берем workspacePath из первой сессии (все сессии в группе имеют одинаковый workspace)
                const workspacePath = sessions.length > 0 ? sessions[0].workspacePath : undefined;
                groups.push({
                    workspaceName,
                    workspacePath,
                    sessions: sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
                });
            }
        });

        return groups.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
    }

    private isCurrentWorkspace(group: WorkspaceGroup): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const targetPath = group.workspacePath ? this.normalizeWorkspacePath(group.workspacePath) : undefined;

        for (const folder of workspaceFolders) {
            const folderPath = this.normalizeWorkspacePath(folder.uri.fsPath);

            if (targetPath) {
                if (folderPath === targetPath) {
                    return true;
                }
            } else if (folder.name === group.workspaceName) {
                return true;
            }
        }

        return false;
    }

    private normalizeWorkspacePath(workspacePath: string): string {
        let normalizedPath = workspacePath;
        if (workspacePath.startsWith('file://')) {
            normalizedPath = vscode.Uri.parse(workspacePath).fsPath;
        }

        normalizedPath = path.normalize(normalizedPath).replace(/[\\/]+$/, '');

        if (process.platform === 'win32') {
            return normalizedPath.toLowerCase();
        }

        return normalizedPath;
    }

    private async scanForChatSessions(): Promise<ChatSession[]> {
        const sessions: ChatSession[] = [];
        
        try {
            const userDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
            
            if (!fs.existsSync(userDataPath)) {
                return sessions;
            }

            const workspaceDirs = fs.readdirSync(userDataPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            for (const workspaceDir of workspaceDirs) {
                const chatSessionsPath = path.join(userDataPath, workspaceDir, 'chatSessions');
                
                if (fs.existsSync(chatSessionsPath)) {
                    const workspaceJsonPath = path.join(userDataPath, workspaceDir, 'workspace.json');
                    let workspaceName = workspaceDir.substring(0, 8) + '...'; // Default name
                    
                    // Попробуем получить имя workspace из файла
                    let workspacePath: string | undefined;
                    if (fs.existsSync(workspaceJsonPath)) {
                        try {
                            const workspaceData = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
                            if (workspaceData.folder) {
                                // Конвертируем URI в нормальный путь
                                workspacePath = this.uriToPath(workspaceData.folder);
                                if (workspacePath) {
                                    workspaceName = path.basename(workspacePath);
                                    console.log(`Found workspace from workspace.json: ${workspaceName} -> ${workspacePath}`);
                                }
                            }
                        } catch (error) {
                            console.error('Error reading workspace.json:', error);
                        }
                    }
                    
                    // Если не нашли путь в workspace.json, попробуем найти в recent workspaces
                    if (!workspacePath) {
                        workspacePath = await this.findWorkspaceInRecentList(workspaceName);
                        if (workspacePath) {
                            console.log(`Found workspace from recent list: ${workspaceName} -> ${workspacePath}`);
                        }
                    }
                    
                    // Если всё ещё не нашли, попробуем по названию найти в стандартных местах
                    if (!workspacePath) {
                        workspacePath = await this.searchWorkspaceByName(workspaceName);
                        if (workspacePath) {
                            console.log(`Found workspace by search: ${workspaceName} -> ${workspacePath}`);
                        } else {
                            console.log(`Could not find workspace path for: ${workspaceName}`);
                        }
                    }

                    const sessionFiles = fs.readdirSync(chatSessionsPath)
                        .filter(file => file.endsWith('.json'));

                    for (const sessionFile of sessionFiles) {
                        const sessionPath = path.join(chatSessionsPath, sessionFile);
                        const stats = fs.statSync(sessionPath);
                        
                        try {
                            const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                            const messageCount = sessionData.requests ? sessionData.requests.length : 0;
                            
                            // Пропускаем сессии без requests или с пустым массивом requests
                            if (!sessionData.requests || sessionData.requests.length === 0) {
                                continue;
                            }
                            
                            let customTitle = sessionData.customTitle;
                            
                            // Если нет customTitle, берем первое сообщение из requests
                            if (!customTitle && sessionData.requests && sessionData.requests.length > 0) {
                                const firstRequest = sessionData.requests[0];
                                if (firstRequest && firstRequest.message && firstRequest.message.text) {
                                    // Обрезаем длинные сообщения и убираем переносы строк
                                    customTitle = firstRequest.message.text
                                        .replace(/\n/g, ' ')
                                        .trim()
                                        .substring(0, 50);
                                    if (firstRequest.message.text.length > 50) {
                                        customTitle += '...';
                                    }
                                }
                            }
                            
                            sessions.push({
                                id: path.basename(sessionFile, '.json'),
                                customTitle,
                                workspaceName,
                                workspacePath,
                                lastModified: stats.mtime,
                                filePath: sessionPath,
                                messageCount,
                                storageRoot: chatSessionsPath
                            });
                        } catch (error) {
                            console.error(`Error reading session file ${sessionPath}:`, error);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error scanning chat sessions:', error);
        }

        return sessions;
    }

    private uriToPath(uri: string): string {
        try {
            // Если это URI, конвертируем в путь
            if (uri.startsWith('file://')) {
                return vscode.Uri.parse(uri).fsPath;
            }
            // Если это уже путь, возвращаем как есть
            return uri;
        } catch (error) {
            console.error('Error converting URI to path:', error);
            return uri;
        }
    }

    private async findWorkspaceInRecentList(workspaceName: string): Promise<string | undefined> {
        try {
            // Попробуем найти в recent workspaces VS Code
            const userDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');
            const recentWorkspacesPath = path.join(userDataPath, 'globalStorage', 'state.vscdb');
            
            // VS Code хранит recent workspaces в разных местах, попробуем основные
            const possiblePaths = [
                path.join(userDataPath, 'workspaceStorage'),
                path.join(userDataPath, 'globalStorage'),
            ];
            
            // Поищем в текущих открытых workspaces VS Code
            if (vscode.workspace.workspaceFolders) {
                for (const folder of vscode.workspace.workspaceFolders) {
                    if (path.basename(folder.uri.fsPath) === workspaceName || 
                        folder.name === workspaceName) {
                        return folder.uri.fsPath;
                    }
                }
            }
            
        } catch (error) {
            console.error('Error searching in recent workspaces:', error);
        }
        return undefined;
    }

    public async searchWorkspaceByName(workspaceName: string): Promise<string | undefined> {
        try {
            // Поищем в стандартных местах разработки
            const searchPaths = [
                path.join(os.homedir(), 'Documents'),
                path.join(os.homedir(), 'Documents', 'git'),
                path.join(os.homedir(), 'Projects'),
                path.join(os.homedir(), 'Development'),
                path.join('C:', 'Projects'),
                path.join('C:', 'Dev'),
                path.join('C:', 'Source'),
            ];

            for (const searchPath of searchPaths) {
                if (fs.existsSync(searchPath)) {
                    try {
                        const items = fs.readdirSync(searchPath, { withFileTypes: true });
                        for (const item of items) {
                            if (item.isDirectory() && item.name === workspaceName) {
                                const fullPath = path.join(searchPath, item.name);
                                // Проверим, что это действительно проект (есть хотя бы один из стандартных файлов)
                                const projectFiles = ['.git', '.vscode', 'package.json', '.gitignore', 'README.md'];
                                for (const projectFile of projectFiles) {
                                    if (fs.existsSync(path.join(fullPath, projectFile))) {
                                        return fullPath;
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        // Игнорируем ошибки доступа к папкам
                        continue;
                    }
                }
            }
        } catch (error) {
            console.error('Error searching workspace by name:', error);
        }
        return undefined;
    }
}

// Функция для открытия чата в webview
async function openChatInWebview(session: ChatSession, context: vscode.ExtensionContext) {
    try {
        const sessionInfo = await loadSessionData(session);

        // Создаем webview panel
        const panel = vscode.window.createWebviewPanel(
            'copilotChatViewer',
            session.customTitle || `Chat Session ${session.id}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                enableForms: false,
                localResourceRoots: [context.extensionUri]
            }
        );

        // Генерируем HTML контент
        panel.webview.html = generateChatHTML(sessionInfo.data, session);

    } catch (error) {
        if (error instanceof SessionFileError) {
            handleSessionFileError('openChatInWebview', error);
            return;
        }

        console.error('Error opening chat in webview:', error);
        showCentralizedError('Error opening chat: see logs for details.', 'openChatInWebview:unexpected');
    }
}

async function exportChatToMarkdown(session: ChatSession): Promise<void> {
    try {
        const sessionInfo = await loadSessionData(session);

        const markdown = buildChatMarkdown(sessionInfo.data, session);

        const defaultFileName = sanitizeFileName(session.customTitle || `chat-session-${session.id}`) + '.md';
        const defaultUri = vscode.Uri.file(path.join(os.homedir(), defaultFileName));

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                Markdown: ['md'],
                'All Files': ['*']
            }
        });

        if (!saveUri) {
            return;
        }

        if (saveUri.scheme !== 'file') {
            showCentralizedError(
                'Only file system targets are supported for exporting chat sessions.',
                'exportChatMarkdown:unsupportedScheme'
            );
            return;
        }

        const savePath = path.resolve(saveUri.fsPath);
        let shouldWrite = true;
        try {
            await fs.promises.access(savePath, fs.constants.F_OK);
            const overwrite = await vscode.window.showWarningMessage(
                `File "${path.basename(savePath)}" already exists. Overwrite?`,
                { modal: true },
                'Overwrite'
            );
            if (overwrite !== 'Overwrite') {
                shouldWrite = false;
            }
        } catch {
            // File does not exist; safe to write.
        }

        if (!shouldWrite) {
            vscode.window.showInformationMessage('Export cancelled: file not overwritten.');
            return;
        }

        await fs.promises.writeFile(savePath, markdown, 'utf8');
        vscode.window.showInformationMessage(`Chat exported to ${savePath}`);
    } catch (error) {
        if (error instanceof SessionFileError) {
            handleSessionFileError('exportChatToMarkdown', error);
            return;
        }

        console.error('Error exporting chat to markdown:', error);
        showCentralizedError('Error exporting chat: see logs for details.', 'exportChatMarkdown:unexpected');
    }
}

// Функция для генерации HTML контента чата
function generateChatHTML(sessionData: ChatSessionData, session: ChatSession): string {
    const messages = sessionData.requests || [];
    
    let messagesHtml = '';

    messages.forEach((request, index) => {
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

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat Session</title>
            <style>
                /* Базовые стили, основанные на официальном VS Code Copilot Chat */
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
                    margin: 0;
                    padding: 16px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    line-height: 1.4;
                    font-size: 13px;
                }
                
                .chat-container {
                    max-width: 900px;
                    margin: 0 auto;
                }
                
                .chat-header {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 12px;
                    margin-bottom: 16px;
                }
                
                .chat-title {
                    font-size: 16px;
                    font-weight: 600;
                    margin: 0 0 4px 0;
                    color: var(--vscode-editor-foreground);
                }
                
                .chat-meta {
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                }
                
                /* Стили сообщений, основанные на .interactive-item-container */
                .message {
                    display: flex;
                    margin-bottom: 16px;
                    padding: 8px 16px;
                    gap: 8px;
                    border-radius: 3px;
                    position: relative;
                }
                
                .user-message {
                    background-color: transparent;
                }
                
                .copilot-message {
                    background-color: var(--vscode-chat-requestBackground, transparent);
                }
                
                /* Стили для аватаров, основанные на .header .avatar */
                .avatar {
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    margin-top: 1px;
                    font-size: 12px;
                    outline: 1px solid var(--vscode-contrastBorder, transparent);
                    outline-offset: -1px;
                }
                
                .user-avatar {
                    background-color: var(--vscode-testing-iconPassed);
                    color: var(--vscode-button-foreground);
                }
                
                .copilot-avatar {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                
                /* Контент сообщения */
                .message-body {
                    flex: 1;
                    min-width: 0;
                }
                
                .message-header {
                    display: flex;
                    align-items: center;
                    margin-bottom: 4px;
                    gap: 6px;
                }
                
                .username {
                    font-weight: 600;
                    font-size: 11px;
                    color: var(--vscode-editor-foreground);
                }
                
                /* Стили контента, основанные на .chatMessageContent */
                .message-content {
                    color: var(--vscode-editor-foreground);
                    font-size: 13px;
                    line-height: 1.4;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                    -webkit-user-select: text;
                    user-select: text;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .message-paragraph {
                    margin: 0;
                    white-space: pre-wrap;
                }

                .message-section {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin: 0;
                }

                .section-title {
                    font-size: 11px;
                    font-weight: 600;
                    letter-spacing: 0.04em;
                    text-transform: uppercase;
                    color: var(--vscode-descriptionForeground);
                }

                .section-subtitle {
                    font-weight: 600;
                    color: var(--vscode-editor-foreground);
                }

                .detail-block {
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 8px 10px;
                    background-color: var(--vscode-editor-background);
                }

                .detail-block + .detail-block {
                    margin-top: 8px;
                }

                .detail-title {
                    font-weight: 600;
                    margin-bottom: 6px;
                    color: var(--vscode-editor-foreground);
                }

                .detail-grid {
                    display: grid;
                    grid-template-columns: minmax(120px, 160px) 1fr;
                    gap: 4px 12px;
                    font-size: 12px;
                }

                .detail-key {
                    color: var(--vscode-descriptionForeground);
                }

                .detail-value {
                    color: var(--vscode-editor-foreground);
                    white-space: pre-wrap;
                    word-break: break-word;
                }

                .message-pre {
                    margin: 0;
                    padding: 8px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    font-family: var(--vscode-editor-font-family, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace);
                    font-size: 12px;
                    white-space: pre-wrap;
                }

                details {
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 8px 10px;
                    background-color: var(--vscode-editor-background);
                }

                details + details {
                    margin-top: 8px;
                }

                summary {
                    cursor: pointer;
                    font-weight: 600;
                    color: var(--vscode-textLink-foreground);
                }

                .raw-json pre {
                    margin: 0;
                }
                
                /* Markdown стили */
                .message-content h1, .message-content h2, .message-content h3 {
                    margin: 16px 0 8px 0;
                    color: var(--vscode-editor-foreground);
                    font-weight: 600;
                }
                
                .message-content h1 { font-size: 18px; }
                .message-content h2 { font-size: 16px; }
                .message-content h3 { font-size: 14px; }
                
                .message-content p {
                    margin: 8px 0;
                }
                
                .message-content ul, .message-content ol {
                    margin: 8px 0;
                    padding-left: 20px;
                }
                
                .message-content li {
                    margin: 2px 0;
                }
                
                .message-content strong {
                    font-weight: 600;
                }
                
                .message-content em {
                    font-style: italic;
                }
                
                /* Код блоки, стили основанные на VS Code */
                .message-content pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 3px;
                    padding: 8px 12px;
                    margin: 8px 0;
                    overflow-x: auto;
                    font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace);
                    font-size: 12px;
                    line-height: 1.357;
                }
                
                .message-content code {
                    background-color: var(--vscode-textPreformat-background);
                    color: var(--vscode-textPreformat-foreground);
                    padding: 1px 3px;
                    border-radius: 3px;
                    font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace);
                    font-size: 12px;
                }
                
                .message-content pre code {
                    background: transparent;
                    padding: 0;
                    color: var(--vscode-editor-foreground);
                }
                
                /* Блок цитат */
                .message-content blockquote {
                    margin: 8px 0;
                    padding: 0 12px;
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                    background-color: var(--vscode-textBlockQuote-background);
                    color: var(--vscode-textBlockQuote-foreground);
                }
                
                /* Таблицы */
                .message-content table {
                    border-collapse: collapse;
                    margin: 8px 0;
                    width: 100%;
                }
                
                .message-content th, .message-content td {
                    border: 1px solid var(--vscode-panel-border);
                    padding: 6px 8px;
                    text-align: left;
                }
                
                .message-content th {
                    background-color: var(--vscode-keybindingTable-headerBackground);
                    font-weight: 600;
                }
                
                /* Ссылки */
                .message-content a {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: none;
                }
                
                .message-content a:hover {
                    color: var(--vscode-textLink-activeForeground);
                    text-decoration: underline;
                }
                
                /* Пустой чат */
                .empty-chat {
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    padding: 40px 20px;
                    font-style: italic;
                    font-size: 13px;
                }
                
                /* Responsive design */
                @media (max-width: 600px) {
                    body {
                        padding: 8px;
                    }
                    
                    .message {
                        padding: 6px 12px;
                        gap: 6px;
                    }
                    
                    .avatar {
                        width: 18px;
                        height: 18px;
                        font-size: 10px;
                    }
                    
                    .message-content {
                        font-size: 12px;
                    }
                }
            </style>
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

// Вспомогательные функции
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCodeContent(text: string): string {
    // Улучшенное форматирование markdown для аутентичного отображения
    let formatted = escapeHtml(text);
    
    // Блоки кода с четырьмя обратными кавычками (как в VS Code Copilot)
    formatted = formatted.replace(/````(\w*)\n?([\s\S]*?)````/g, (match, lang, code) => {
        return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });
    
    // Обычные блоки кода с тремя обратными кавычками
    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });
    
    // Inline код
    formatted = formatted.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    
    // Жирный текст
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Курсив
    formatted = formatted.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, '<em>$1</em>');
    
    // Заголовки
    formatted = formatted.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    formatted = formatted.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    formatted = formatted.replace(/^# (.*$)/gm, '<h1>$1</h1>');
    
    // Цитаты
    formatted = formatted.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');
    
    // Нумерованные списки
    formatted = formatted.replace(/^\d+\.\s+(.*$)/gm, '<li>$1</li>');
    formatted = formatted.replace(/(<li>.*<\/li>)/gs, (match) => {
        if (!match.includes('<ol>')) {
            return '<ol>' + match + '</ol>';
        }
        return match;
    });
    
    // Маркированные списки  
    formatted = formatted.replace(/^[\s]*[-*+]\s+(.*$)/gm, '<li>$1</li>');
    formatted = formatted.replace(/(<li>.*<\/li>)/gs, (match) => {
        if (!match.includes('<ul>') && !match.includes('<ol>')) {
            return '<ul>' + match + '</ul>';
        }
        return match;
    });
    
    // Ссылки
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    
    // Простые URL
    formatted = formatted.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
    
    // Разделители
    formatted = formatted.replace(/^---$/gm, '<hr>');
    
    // Переносы строк - два пробела в конце строки
    formatted = formatted.replace(/  \n/g, '<br>\n');
    
    // Абзацы
    formatted = formatted.replace(/\n\s*\n/g, '</p><p>');
    
    // Обернуть в абзац, если еще не обернуто
    if (!formatted.startsWith('<') && formatted.trim() !== '') {
        formatted = '<p>' + formatted + '</p>';
    }
    
    // Очистка пустых абзацев
    formatted = formatted.replace(/<p>\s*<\/p>/g, '');

    return formatted;
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

    const additionalSection = renderAdditionalDataSection(request);
    if (additionalSection) {
        sections.push(additionalSection);
    }

    return sections;
}

function renderAssistantTextSection(request: ChatMessage): string | undefined {
    const fragments: string[] = [];

    (request.response ?? []).forEach(item => {
        const value = typeof item.value === 'string' ? item.value.trim() : '';
        if (!value) {
            return;
        }

        const languageId = typeof item.languageId === 'string' ? item.languageId : undefined;
        fragments.push(renderValueAsHtml(value, languageId));
    });

    if (fragments.length === 0) {
        return undefined;
    }

    return `<div class="message-section">${fragments.join('')}</div>`;
}

function collectCommandRuns(request: ChatMessage): ChatCommandRun[] {
    const runs: ChatCommandRun[] = [];
    const seen = new Set<string>();

    const addRun = (run: ChatCommandRun | undefined) => {
        if (!run) {
            return;
        }

        const normalized: ChatCommandRun = {
            title: typeof run.title === 'string' ? run.title : undefined,
            command: typeof run.command === 'string' ? run.command : undefined,
            arguments: run.arguments,
            result: run.result,
            status: typeof run.status === 'string' ? run.status : undefined,
            output: typeof run.output === 'string' ? run.output : undefined,
            timestamp: typeof run.timestamp === 'number' ? run.timestamp : undefined
        };

        const key = JSON.stringify(normalized, Object.keys(normalized).sort());
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        runs.push(normalized);
    };

    (request.commandRuns ?? []).forEach(addRun);

    (request.response ?? []).forEach(item => {
        const responseRuns = item.commandRuns;
        if (Array.isArray(responseRuns)) {
            responseRuns.forEach(addRun);
        }

        if (
            typeof item.command === 'string' ||
            typeof item.title === 'string' ||
            item.arguments !== undefined ||
            item.result !== undefined ||
            item.output !== undefined ||
            typeof item.status === 'string'
        ) {
            addRun({
                title: typeof item.title === 'string' ? item.title : undefined,
                command: typeof item.command === 'string' ? item.command : undefined,
                arguments: item.arguments,
                result: item.result,
                status: typeof item.status === 'string' ? item.status : undefined,
                output: typeof item.output === 'string' ? item.output : undefined
            });
        }
    });

    return runs;
}

function collectToolInvocations(request: ChatMessage): ChatToolInvocation[] {
    const invocations: ChatToolInvocation[] = [];
    const seen = new Set<string>();

    const addInvocation = (invocation: ChatToolInvocation | undefined) => {
        if (!invocation) {
            return;
        }

        const normalized: ChatToolInvocation = {
            toolName: typeof invocation.toolName === 'string' ? invocation.toolName : undefined,
            name: typeof invocation.name === 'string' ? invocation.name : undefined,
            status: typeof invocation.status === 'string' ? invocation.status : undefined,
            input: invocation.input ?? invocation.arguments,
            result: invocation.result,
            output: invocation.output,
            error: invocation.error,
            metadata: invocation.metadata,
            startTime: typeof invocation.startTime === 'number' ? invocation.startTime : undefined,
            endTime: typeof invocation.endTime === 'number' ? invocation.endTime : undefined
        };

        const key = JSON.stringify(normalized, Object.keys(normalized).sort());
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        invocations.push(normalized);
    };

    (request.toolInvocations ?? []).forEach(addInvocation);

    (request.response ?? []).forEach(item => {
        const responseInvocations = item.toolInvocations;
        if (Array.isArray(responseInvocations)) {
            responseInvocations.forEach(addInvocation);
        }

        if (typeof item.toolInvocations === 'object' && !Array.isArray(item.toolInvocations) && item.toolInvocations !== null) {
            addInvocation(item.toolInvocations as ChatToolInvocation);
        }

        if (typeof (item as { toolName?: unknown }).toolName === 'string' || typeof (item as { toolId?: unknown }).toolId === 'string') {
            const anyItem = item as Record<string, unknown>;
            addInvocation({
                toolName: typeof anyItem.toolName === 'string' ? (anyItem.toolName as string) : (typeof anyItem.toolId === 'string' ? (anyItem.toolId as string) : undefined),
                name: typeof anyItem.name === 'string' ? (anyItem.name as string) : undefined,
                status: typeof anyItem.status === 'string' ? (anyItem.status as string) : undefined,
                input: anyItem.input ?? anyItem.arguments,
                result: anyItem.result,
                output: anyItem.output,
                error: anyItem.error,
                metadata: typeof anyItem.metadata === 'object' ? (anyItem.metadata as Record<string, unknown>) : undefined
            });
        }
    });

    return invocations;
}

function collectFileChanges(request: ChatMessage): ChatFileChange[] {
    const changes: ChatFileChange[] = [];
    const seen = new Set<string>();

    const addChange = (change: ChatFileChange | undefined) => {
        if (!change) {
            return;
        }

        const normalized: ChatFileChange = {
            path: typeof change.path === 'string' ? change.path : undefined,
            uri: typeof change.uri === 'string' ? change.uri : undefined,
            diff: typeof change.diff === 'string' ? change.diff : undefined,
            content: typeof change.content === 'string' ? change.content : undefined,
            explanation: typeof change.explanation === 'string' ? change.explanation : undefined,
            languageId: typeof change.languageId === 'string' ? change.languageId : undefined
        };

        if (!normalized.diff && !normalized.content && !normalized.explanation) {
            return;
        }

        const key = JSON.stringify(normalized, Object.keys(normalized).sort());
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        changes.push(normalized);
    };

    (request.fileChanges ?? []).forEach(addChange);

    (request.response ?? []).forEach(item => {
        const responseChanges = item.fileChanges;
        if (Array.isArray(responseChanges)) {
            responseChanges.forEach(addChange);
        }

        const responseEdits = (item as { fileEdits?: unknown }).fileEdits;
        if (Array.isArray(responseEdits)) {
            (responseEdits as ChatFileChange[]).forEach(addChange);
        }

        const responseFiles = item.files;
        if (Array.isArray(responseFiles)) {
            responseFiles.forEach(addChange);
        }

        const anyItem = item as Record<string, unknown>;
        if (typeof anyItem.path === 'string' || typeof anyItem.diff === 'string' || typeof anyItem.content === 'string') {
            addChange({
                path: typeof anyItem.path === 'string' ? (anyItem.path as string) : undefined,
                diff: typeof anyItem.diff === 'string' ? (anyItem.diff as string) : undefined,
                content: typeof anyItem.content === 'string' ? (anyItem.content as string) : undefined,
                explanation: typeof anyItem.explanation === 'string' ? (anyItem.explanation as string) : undefined,
                languageId: typeof item.languageId === 'string' ? item.languageId : undefined
            });
        }
    });

    return changes;
}

function renderFileChangesSection(changes: ChatFileChange[]): string | undefined {
    if (changes.length === 0) {
        return undefined;
    }

    const blocks = changes.map((change, index) => {
        const parts: string[] = [];
        const label = change.path || change.uri || `Change ${index + 1}`;
        parts.push(`<div class="section-subtitle">${escapeHtml(label)}</div>`);

        if (change.explanation) {
            parts.push(renderParagraph(change.explanation));
        }

        const codeContent = change.diff ?? change.content;
        if (codeContent) {
            const languageId = change.languageId || (change.diff ? 'diff' : undefined);
            parts.push(renderValueAsHtml(codeContent, languageId));
        }

        return `<div class="detail-block">${parts.join('')}</div>`;
    });

    return `
        <div class="message-section">
            <div class="section-title">File changes</div>
            ${blocks.join('')}
        </div>
    `;
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

    return `
        <div class="message-section">
            <div class="section-title">Executed commands</div>
            ${entries.join('')}
        </div>
    `;
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

    return `
        <div class="message-section">
            <div class="section-title">Tool invocations</div>
            ${entries.join('')}
        </div>
    `;
}

function renderAdditionalDataSection(request: ChatMessage): string | undefined {
    const extraSections: string[] = [];
    const requestKnownKeys = new Set(['message', 'response', 'commandRuns', 'toolInvocations', 'fileChanges', 'timestamp']);
    const requestExtra = extractAdditionalData(request, requestKnownKeys);
    if (requestExtra) {
        extraSections.push(`<details open><summary>Request metadata</summary>${requestExtra}</details>`);
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

    return `
        <div class="message-section">
            <div class="section-title">Additional data</div>
            ${extraSections.join('')}
        </div>
    `;
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

    const data = Object.fromEntries(entries);
    return formatJsonValue(data);
}

function renderDetailRows(rows: Array<[string, unknown]>): string {
    const cells = rows
        .map(([label, value]) => {
            const formatted = formatDetailValue(value);
            if (!formatted) {
                return undefined;
            }
            return `<div class="detail-key">${escapeHtml(label)}</div><div class="detail-value">${formatted}</div>`;
        })
        .filter((cell): cell is string => Boolean(cell));

    if (cells.length === 0) {
        return '';
    }

    return `<div class="detail-grid">${cells.join('')}</div>`;
}

function formatDetailValue(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return undefined;
        }
        return escapeHtml(trimmed);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return escapeHtml(String(value));
    }

    return formatStructuredValue(value);
}

function formatStructuredValue(value: unknown): string {
    if (typeof value === 'string') {
        return escapeHtml(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return escapeHtml(String(value));
    }

    if (value === null) {
        return '<em>null</em>';
    }

    return formatJsonValue(value);
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

function formatJsonValue(value: unknown): string {
    let json: string;
    try {
        json = JSON.stringify(value, null, 2);
    } catch (error) {
        json = String(value);
    }

    return `<div class="raw-json"><pre class="message-pre"><code class="language-json">${escapeHtml(json)}</code></pre></div>`;
}

function renderParagraph(text: string): string {
    return `<div class="message-paragraph">${escapeHtml(text)}</div>`;
}

function renderValueAsHtml(value: string, languageId?: string): string {
    if (languageId && !['markdown', 'plaintext', 'text'].includes(languageId)) {
        const sanitizedLanguage = escapeLanguageId(languageId);
        return `<pre><code class="language-${sanitizedLanguage}">${escapeHtml(value)}</code></pre>`;
    }

    const formatted = formatCodeContent(value);
    return ensureParagraphWrapper(formatted);
}

function ensureParagraphWrapper(content: string): string {
    const blockIndicators = ['<pre', '<table', '<ol', '<ul', '<h1', '<h2', '<h3', '<blockquote', '<hr'];
    if (blockIndicators.some(indicator => content.includes(indicator))) {
        return content;
    }

    return `<div class="message-paragraph">${content}</div>`;
}

function escapeLanguageId(languageId: string): string {
    const sanitized = languageId.replace(/[^a-zA-Z0-9_-]+/g, '-');
    return sanitized || 'text';
}

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

export function activate(context: vscode.ExtensionContext) {
    // Создаем провайдер данных
    const chatHistoryProvider = new CopilotChatHistoryProvider();
    
    // Регистрируем tree view
    vscode.window.createTreeView('copilotChatHistoryView', {
        treeDataProvider: chatHistoryProvider,
        showCollapseAll: true
    });

    // Регистрируем команды
    const refreshCommand = vscode.commands.registerCommand('copilotChatHistory.refresh', () => {
        chatHistoryProvider.refresh();
    });

    const openChatCommand = vscode.commands.registerCommand('copilotChatHistory.openChat', async (session: ChatSession) => {
        // Открываем чат в специальном webview вместо JSON файла
        await openChatInWebview(session, context);
    });

    const openChatJsonCommand = vscode.commands.registerCommand('copilotChatHistory.openChatJson', async (session: ChatSession) => {
        try {
            const sessionFilePath = await resolveAccessibleSessionFilePath(session);
            const document = await vscode.workspace.openTextDocument(sessionFilePath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            if (error instanceof SessionFileError) {
                handleSessionFileError('openChatJson', error);
                return;
            }

            console.error('Error opening chat JSON document:', error);
            showCentralizedError('Error opening chat JSON: see logs for details.', 'openChatJson:unexpected');
        }
    });

    const exportChatMarkdownCommand = vscode.commands.registerCommand('copilotChatHistory.exportChatMarkdown', async (session: ChatSession) => {
        await exportChatToMarkdown(session);
    });

    const helloWorldCommand = vscode.commands.registerCommand('copilotChatHistory.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Copilot Chat History extension!');
    });

    const searchCommand = vscode.commands.registerCommand('copilotChatHistory.search', async () => {
        const searchText = await vscode.window.showInputBox({
            placeHolder: 'Enter search text...',
            prompt: 'Search chat sessions by title'
        });
        
        if (searchText !== undefined) {
            chatHistoryProvider.setSearchFilter(searchText);
            if (searchText.trim()) {
                vscode.window.showInformationMessage(`Filtered by: "${searchText}"`);
            }
        }
    });

    const clearFilterCommand = vscode.commands.registerCommand('copilotChatHistory.clearFilter', () => {
        chatHistoryProvider.clearFilter();
        vscode.window.showInformationMessage('Filter cleared');
    });

    const openWorkspaceInCurrentWindowCommand = vscode.commands.registerCommand('copilotChatHistory.openWorkspaceInCurrentWindow', async (workspaceGroup: WorkspaceGroup) => {
        console.log('Opening workspace:', workspaceGroup.workspaceName, 'Path:', workspaceGroup.workspacePath);
        
        if (workspaceGroup.workspacePath) {
            // Убеждаемся, что путь конвертирован из URI
            const normalizedPath = workspaceGroup.workspacePath.startsWith('file://') 
                ? vscode.Uri.parse(workspaceGroup.workspacePath).fsPath 
                : workspaceGroup.workspacePath;
                
            if (fs.existsSync(normalizedPath)) {
                const workspaceUri = vscode.Uri.file(normalizedPath);
                await vscode.commands.executeCommand('vscode.openFolder', workspaceUri, false);
            } else {
                showCentralizedError(
                    `Workspace path does not exist: ${normalizedPath}`,
                    'openWorkspaceCurrent:missingPath'
                );
            }
        } else {
            // Попробуем найти workspace вручную
            const foundPath = await chatHistoryProvider.searchWorkspaceByName(workspaceGroup.workspaceName);
            if (foundPath && fs.existsSync(foundPath)) {
                const workspaceUri = vscode.Uri.file(foundPath);
                await vscode.commands.executeCommand('vscode.openFolder', workspaceUri, false);
                vscode.window.showInformationMessage(`Found and opened workspace: ${foundPath}`);
            } else {
                showCentralizedError(
                    `Workspace path not found for: ${workspaceGroup.workspaceName}. Please open it manually.`,
                    'openWorkspaceCurrent:notFound'
                );
            }
        }
    });

    const openWorkspaceInNewWindowCommand = vscode.commands.registerCommand('copilotChatHistory.openWorkspaceInNewWindow', async (workspaceGroup: WorkspaceGroup) => {
        console.log('Opening workspace in new window:', workspaceGroup.workspaceName, 'Path:', workspaceGroup.workspacePath);
        
        if (workspaceGroup.workspacePath) {
            // Убеждаемся, что путь конвертирован из URI
            const normalizedPath = workspaceGroup.workspacePath.startsWith('file://') 
                ? vscode.Uri.parse(workspaceGroup.workspacePath).fsPath 
                : workspaceGroup.workspacePath;
                
            if (fs.existsSync(normalizedPath)) {
                const workspaceUri = vscode.Uri.file(normalizedPath);
                await vscode.commands.executeCommand('vscode.openFolder', workspaceUri, true);
            } else {
                showCentralizedError(
                    `Workspace path does not exist: ${normalizedPath}`,
                    'openWorkspaceNewWindow:missingPath'
                );
            }
        } else {
            // Попробуем найти workspace вручную
            const foundPath = await chatHistoryProvider.searchWorkspaceByName(workspaceGroup.workspaceName);
            if (foundPath && fs.existsSync(foundPath)) {
                const workspaceUri = vscode.Uri.file(foundPath);
                await vscode.commands.executeCommand('vscode.openFolder', workspaceUri, true);
                vscode.window.showInformationMessage(`Found and opened workspace: ${foundPath}`);
            } else {
                showCentralizedError(
                    `Workspace path not found for: ${workspaceGroup.workspaceName}. Please open it manually.`,
                    'openWorkspaceNewWindow:notFound'
                );
            }
        }
    });

    context.subscriptions.push(refreshCommand, openChatCommand, openChatJsonCommand, helloWorldCommand, searchCommand, clearFilterCommand, openWorkspaceInCurrentWindowCommand, openWorkspaceInNewWindowCommand, exportChatMarkdownCommand);

    // Автоматически обновляем при активации
    chatHistoryProvider.refresh();
    
    // Показываем сообщение о том, что расширение активировано
    console.log('Copilot Chat History extension is now active!');
}

export function deactivate() {}
