import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import type { ChatSession } from './types';
const trash = require('trash');
import { buildChatMarkdown, sanitizeFileName } from './markdown/chatMarkdown';
import { generateChatHTML } from './renderers/chatRenderer';
import { getChatStyles } from './renderers/styles';
import { showCentralizedError } from './utils/notifications';
import { loadSessionData, resolveAccessibleSessionFilePath, resolveSessionFilePath, SessionFileError } from './utils/sessionFiles';

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

// Helper types and methods for archive (soft-delete) support
interface ArchiveEntry {
    originalPath: string;
    archivePath: string;
    sessionId: string;
}

async function ensureDir(dirPath: string): Promise<void> {
    try {
        await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (err) {
        // ignore
    }
}

async function moveFileTo(dest: string, src: string): Promise<void> {
    try {
        await ensureDir(path.dirname(dest));
        await fs.promises.rename(src, dest);
    } catch (err) {
        // fallback to copy+unlink for cross-device moves
        try {
            await ensureDir(path.dirname(dest));
            await fs.promises.copyFile(src, dest);
            await fs.promises.unlink(src);
        } catch (copyErr) {
            throw copyErr;
        }
    }
}

async function moveSessionToArchive(context: vscode.ExtensionContext, session: ChatSession, provider?: any): Promise<ArchiveEntry> {
    // Use extension global storage so archived sessions are not scanned by Copilot and don't affect history
    const baseRoot = context.globalStorageUri.fsPath;
    const workspaceDirName = sanitizeFileName(session.workspaceName || 'unknown-workspace');
    const archiveDir = path.join(baseRoot, 'archive', workspaceDirName);
    await ensureDir(archiveDir);

    const srcPath = await resolveSessionFilePath(session);
    const baseName = path.basename(srcPath);
    let destPath = path.join(archiveDir, baseName);

    // Avoid collisions in archive by appending timestamp if exists
    if (fs.existsSync(destPath)) {
        const ts = Date.now();
        destPath = path.join(archiveDir, `${baseName}.${ts}`);
    }

    await moveFileTo(destPath, srcPath);

    // Store metadata alongside the archived file so we can restore later
    const meta = {
        originalPath: srcPath,
        sessionId: session.id,
        workspaceName: session.workspaceName || null,
        archivedAt: new Date().toISOString()
    };
    try {
        await fs.promises.writeFile(destPath + '.meta.json', JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to write archive metadata for', destPath, err);
    }

    // Remove from cache if provider is passed
    if (provider && provider.cachedSessions) {
        provider.cachedSessions = provider.cachedSessions.filter((s: ChatSession) => s.id !== session.id);
    }

    return { originalPath: srcPath, archivePath: destPath, sessionId: session.id };
}

async function restoreArchivedEntries(entries: ArchiveEntry[]): Promise<void> {
    for (const entry of entries) {
        try {
            const targetDir = path.dirname(entry.originalPath);
            await ensureDir(targetDir);
            // If original path exists (unlikely), append timestamp
            let restorePath = entry.originalPath;
            if (fs.existsSync(restorePath)) {
                const ts = Date.now();
                const ext = path.extname(restorePath);
                const name = path.basename(restorePath, ext);
                restorePath = path.join(targetDir, `${name}.restored.${ts}${ext}`);
            }
            await moveFileTo(restorePath, entry.archivePath);
        } catch (error) {
            console.error('Error restoring archived file:', error);
        }
    }
}

// Remove empty workspace directories from archive
async function removeEmptyArchiveWorkspace(workspacePath: string): Promise<void> {
    try {
        if (!fs.existsSync(workspacePath)) return;
        const files = fs.readdirSync(workspacePath);
        const hasConversations = files.some(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
        if (!hasConversations) {
            // Directory is empty of conversations, remove it
            await fs.promises.rmdir(workspacePath, { recursive: true });
        }
    } catch (err) {
        console.error('Error removing empty archive workspace:', err);
    }
}

// Tree Data Provider для отображения истории чатов
class CopilotChatHistoryProvider implements vscode.TreeDataProvider<ChatSession | WorkspaceGroup> {
    private _onDidChangeTreeData: vscode.EventEmitter<ChatSession | WorkspaceGroup | undefined | null | void> = new vscode.EventEmitter<ChatSession | WorkspaceGroup | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ChatSession | WorkspaceGroup | undefined | null | void> = this._onDidChangeTreeData.event;
    private _searchFilter: string = '';

    public cachedSessions: ChatSession[] = [];
    private scanning: boolean = false;
    private scanProgress: { message?: string, percent?: number } = {};
    private cacheKey = 'copilotChatHistory.sessions.cache';
    private expandedWorkspaces: Set<string> = new Set(); // Track which workspaces show all sessions

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    isScanning(): boolean {
        return this.scanning;
    }

    getScanProgress(): { message?: string, percent?: number } {
        return this.scanProgress;
    }

    toggleExpandedWorkspace(workspaceName: string): void {
        if (this.expandedWorkspaces.has(workspaceName)) {
            this.expandedWorkspaces.delete(workspaceName);
        } else {
            this.expandedWorkspaces.add(workspaceName);
        }
        this.refresh();
    }

    async loadCache(context?: vscode.ExtensionContext) {
        try {
            if (context) {
                const cached = context.globalState.get<ChatSession[]>(this.cacheKey);
                if (cached && cached.length > 0) {
                    this.cachedSessions = cached;
                    this.refresh();
                }
            }
        } catch (err) {
            console.error('Error loading session cache:', err);
        }
    }

    async saveCache(context: vscode.ExtensionContext) {
        try {
            await context.globalState.update(this.cacheKey, this.cachedSessions);
        } catch (err) {
            console.error('Error saving session cache:', err);
        }
    }

    // Start an asynchronous background scan that updates the cached sessions incrementally and refreshes the view
    async startBackgroundScan(context: vscode.ExtensionContext, onProgress?: (msg: string) => void) {
        if (this.scanning) return;
        this.scanning = true;
        this.scanProgress = { message: 'Starting background scan', percent: 0 };
        try {
            // Load cached entries first to make the view responsive
            await this.loadCache(context);

            // Perform incremental scan: for each workspace dir update cache and refresh
            const userDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
            if (!fs.existsSync(userDataPath)) {
                this.scanning = false;
                this.scanProgress = {};
                return;
            }

            const workspaceDirs = fs.readdirSync(userDataPath, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            const total = workspaceDirs.length || 1;
            let processed = 0;
            const newSessions: ChatSession[] = [];

            for (const workspaceDir of workspaceDirs) {
                if (!workspaceDir) continue;
                this.scanProgress = { message: `Scanning workspace ${workspaceDir}...`, percent: Math.round((processed / total) * 100) };
                try {
                    const chatSessionsPath = path.join(userDataPath, workspaceDir, 'chatSessions');
                    if (!fs.existsSync(chatSessionsPath)) { processed++; continue; }

                    const workspaceJsonPath = path.join(userDataPath, workspaceDir, 'workspace.json');
                    let workspaceName = workspaceDir.substring(0, 8) + '...';
                    let workspacePath: string | undefined;
                    if (fs.existsSync(workspaceJsonPath)) {
                        try {
                            const workspaceData = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
                            if (workspaceData.folder) {
                                workspacePath = this.uriToPath(workspaceData.folder);
                                if (workspacePath) workspaceName = path.basename(workspacePath);
                            }
                        } catch (err) {}
                    }

                    const sessionFiles = fs.readdirSync(chatSessionsPath).filter(f => f.endsWith('.json'));
                    for (const sessionFile of sessionFiles) {
                        const sessionPath = path.join(chatSessionsPath, sessionFile);
                        try {
                            const stats = fs.statSync(sessionPath);
                            const raw = fs.readFileSync(sessionPath, 'utf8');
                            const sessionData = JSON.parse(raw);
                            const messageCount = sessionData.requests ? sessionData.requests.length : 0;
                            if (!sessionData.requests || sessionData.requests.length === 0) continue;
                            let customTitle = sessionData.customTitle;
                            if (!customTitle && sessionData.requests && sessionData.requests.length > 0) {
                                const firstRequest = sessionData.requests[0];
                                if (firstRequest && firstRequest.message && firstRequest.message.text) {
                                    customTitle = firstRequest.message.text.replace(/\n/g, ' ').trim().substring(0, 50);
                                    if (firstRequest.message.text.length > 50) customTitle += '...';
                                }
                            }
                            newSessions.push({
                                id: path.basename(sessionFile, '.json'),
                                customTitle,
                                workspaceName,
                                workspacePath,
                                lastModified: stats.mtime,
                                filePath: sessionPath,
                                messageCount,
                                storageRoot: chatSessionsPath
                            });
                        } catch (err) {
                            // ignore per-file errors
                            console.error('Error reading session during background scan:', sessionPath, err);
                        }
                    }
                } catch (err) {
                    console.error('Error scanning workspace during background scan:', workspaceDir, err);
                }
                processed++;
                // Incremental update: replace cache and refresh UI
                this.cachedSessions = newSessions.slice();
                this.refresh();
                if (onProgress) onProgress(this.scanProgress.message || 'Scanning...');
                // Yield to event loop to keep UI responsive
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            // Finalize
            this.cachedSessions = newSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
            await this.saveCache(context);
            this.refresh();
        } catch (err) {
            console.error('Background scan failed:', err);
        } finally {
            this.scanning = false;
            this.scanProgress = {};
            if (onProgress) onProgress('');
        }
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
            // Check if this is a loading indicator
            if (element.workspaceName === '__loading__') {
                const item = new vscode.TreeItem('Loading workspaces...', vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('loading~spin');
                item.description = this.scanProgress.message ? this.scanProgress.message.substring(0, 50) : '';
                item.tooltip = `Scanning for chat history... ${this.scanProgress.percent ? `(${this.scanProgress.percent}%)` : ''}`;
                item.contextValue = 'loadingIndicator';
                return item;
            }
            
            // Это группа workspace
            const isCurrentWorkspace = this.isCurrentWorkspace(element);
            const item = new vscode.TreeItem(element.workspaceName, vscode.TreeItemCollapsibleState.Collapsed);
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
            
            // Add action buttons for workspace group
            (item as any).buttons = [
                {
                    iconPath: new vscode.ThemeIcon('arrow-right'),
                    tooltip: 'Open in Current Window',
                    command: {
                        command: 'copilotChatHistory.openWorkspaceInCurrentWindow',
                        title: 'Open in Current Window',
                        arguments: [element]
                    }
                },
                {
                    iconPath: new vscode.ThemeIcon('link-external'),
                    tooltip: 'Open in New Window',
                    command: {
                        command: 'copilotChatHistory.openWorkspaceInNewWindow',
                        title: 'Open in New Window',
                        arguments: [element]
                    }
                },
                {
                    iconPath: new vscode.ThemeIcon('archive'),
                    tooltip: 'Archive All',
                    command: {
                        command: 'copilotChatHistory.archiveAllConversations',
                        title: 'Archive All',
                        arguments: [element]
                    }
                },
                {
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: 'Delete All',
                    command: {
                        command: 'copilotChatHistory.deleteWorkspaceConversations',
                        title: 'Delete All',
                        arguments: [element]
                    }
                }
            ];
            
            console.log('Created workspace TreeItem:', item.label, 'contextValue:', item.contextValue);
            return item;
        } else {
            // Check if this is a "Load More" placeholder
            if (element.id.startsWith('__loadmore__')) {
                const workspaceName = element.id.replace('__loadmore__', '');
                const item = new vscode.TreeItem(element.customTitle || 'Load More', vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('ellipsis');
                item.tooltip = 'Click to show all conversations';
                item.contextValue = 'loadMorePlaceholder';
                item.command = {
                    command: 'copilotChatHistory.loadMoreConversations',
                    title: 'Load More',
                    arguments: [workspaceName]
                };
                return item;
            }
            
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
            
            // Add action buttons for chat session
            (item as any).buttons = [
                {
                    iconPath: new vscode.ThemeIcon('archive'),
                    tooltip: 'Archive',
                    command: {
                        command: 'copilotChatHistory.archiveConversation',
                        title: 'Archive',
                        arguments: [element]
                    }
                },
                {
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: 'Delete',
                    command: {
                        command: 'copilotChatHistory.deleteConversation',
                        title: 'Delete',
                        arguments: [element]
                    }
                }
            ];
            
            return item;
        }
    }

    getChildren(element?: ChatSession | WorkspaceGroup): Thenable<(ChatSession | WorkspaceGroup)[]> {
        if (!element) {
            // Root level - возвращаем группы workspace
            return Promise.resolve(this.getChatSessions());
        } else if ('sessions' in element) {
            // Возвращаем отфильтрованные сессии для данного workspace
            const allFilteredSessions = element.sessions.filter(session => this.matchesFilter(session));
            
            // Check if this workspace is expanded to show all sessions
            const isExpanded = this.expandedWorkspaces.has(element.workspaceName);
            const sessionsToShow = isExpanded ? allFilteredSessions : allFilteredSessions.slice(0, 20);
            
            // If there are more sessions and not expanded, add a "Load More" placeholder
            if (!isExpanded && allFilteredSessions.length > 20) {
                const moreCount = allFilteredSessions.length - 20;
                const loadMoreSession: ChatSession = {
                    id: `__loadmore__${element.workspaceName}`,
                    customTitle: `📁 Load More (${moreCount} more conversation${moreCount !== 1 ? 's' : ''})`,
                    messageCount: moreCount,
                    lastModified: new Date(0),
                    workspaceName: element.workspaceName,
                    workspacePath: element.workspacePath,
                    filePath: '',
                    storageRoot: ''
                };
                sessionsToShow.push(loadMoreSession);
            }
            
            return Promise.resolve(sessionsToShow);
        } else {
            // Leaf node - нет детей
            return Promise.resolve([]);
        }
    }

    private async getChatSessions(): Promise<WorkspaceGroup[]> {
        // Use cached sessions when available for fast UI load; fall back to full scan if empty
        const chatSessions = (this.cachedSessions && this.cachedSessions.length > 0) ? this.cachedSessions : await this.scanForChatSessions();

        // Group by workspace
        const workspaceMap = new Map<string, ChatSession[]>();

        chatSessions.forEach(session => {
            const existing = workspaceMap.get(session.workspaceName) || [];
            existing.push(session);
            workspaceMap.set(session.workspaceName, existing);
        });

        // Конвертируем в массив групп, исключая пустые после фильтрации
        const groups: WorkspaceGroup[] = [];
        workspaceMap.forEach((sessions, workspaceName) => {
            // Pre-filter and sort sessions for performance - only filter visible items
            const allFilteredSessions = sessions.filter(session => this.matchesFilter(session));
            
            if (allFilteredSessions.length > 0) {
                // Берем workspacePath из первой сессии (все сессии в группе имеют одинаковый workspace)
                const workspacePath = sessions.length > 0 ? sessions[0].workspacePath : undefined;
                
                // Pre-sort all sessions by recency so we don't have to re-sort in getChildren
                const sortedSessions = sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
                
                groups.push({
                    workspaceName,
                    workspacePath,
                    sessions: sortedSessions
                });
            }
        });

        // If scanning, prepend a loading indicator at the top
        if (this.scanning) {
            const loadingSession: ChatSession = {
                id: '__loading__',
                customTitle: `$(loading~spin) ${this.scanProgress.message || 'Scanning workspaces...'}`,
                messageCount: 0,
                lastModified: new Date(),
                workspaceName: '__loading__',
                workspacePath: undefined,
                filePath: '',
                storageRoot: ''
            };
            const loadingGroup: WorkspaceGroup = {
                workspaceName: '__loading__',
                sessions: [loadingSession]
            };
            groups.unshift(loadingGroup);
        }

        return groups.sort((a, b) => {
            // Keep loading indicator at the top
            if (a.workspaceName === '__loading__') return -1;
            if (b.workspaceName === '__loading__') return 1;
            return a.workspaceName.localeCompare(b.workspaceName);
        });
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

    public async listAllChatSessions(force: boolean = false): Promise<ChatSession[]> {
        if (!force && this.cachedSessions && this.cachedSessions.length > 0) {
            return this.cachedSessions;
        }
        const fresh = await this.scanForChatSessions();
        this.cachedSessions = fresh;
        return fresh;
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

    public uriToPath(uri: string): string {
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
        panel.webview.html = generateChatHTML(sessionInfo, getChatStyles(), sessionInfo.data.responderUsername || 'Copilot');

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

export function activate(context: vscode.ExtensionContext) {
    // Создаем провайдер данных
    const chatHistoryProvider = new CopilotChatHistoryProvider();
    
    // Регистрируем tree view (multi-select enabled)
    const chatTreeView = vscode.window.createTreeView('copilotChatHistoryView', {
        treeDataProvider: chatHistoryProvider,
        showCollapseAll: true,
        canSelectMany: true
    });

    // Archive provider & view
    const archiveProvider = new (require('./archiveProvider').ArchiveProvider)(context);
    const archiveTreeView = vscode.window.createTreeView('copilotArchiveView', {
        treeDataProvider: archiveProvider,
        showCollapseAll: true
    });

    // Helper to safely register commands (skip if already registered by another extension)
    function safeRegister(commandId: string, callback: (...args: any[]) => any): vscode.Disposable {
        try {
            const d = vscode.commands.registerCommand(commandId, callback);
            return d;
        } catch (err) {
            console.warn(`Skipping registration of ${commandId}:`, err && (err as Error).message);
            return { dispose() { /* noop */ } } as vscode.Disposable;
        }
    }

    // Регистрируем команды
    const refreshCommand = safeRegister('copilotChatHistory.refresh', async () => {
        // Force reload from disk by clearing cache and re-scanning
        chatHistoryProvider.cachedSessions = [];
        await chatHistoryProvider.listAllChatSessions(true);
        chatHistoryProvider.refresh();
        vscode.window.showInformationMessage('Chat sessions refreshed.');
    });
    
    const archiveRefreshCommand = safeRegister('copilotChatHistory.archiveRefresh', () => {
        archiveProvider.refresh();
        vscode.window.showInformationMessage('Archive refreshed.');
    });

    const openChatCommand = safeRegister('copilotChatHistory.openChat', async (session: ChatSession) => {
        // Открываем чат в специальном webview вместо JSON файла
        await openChatInWebview(session, context);
    });

    const openChatJsonCommand = safeRegister('copilotChatHistory.openChatJson', async (session: ChatSession) => {
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

    const exportChatMarkdownCommand = safeRegister('copilotChatHistory.exportChatMarkdown', async (session: ChatSession) => {
        await exportChatToMarkdown(session);
    });

    const helloWorldCommand = safeRegister('copilotChatHistory.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Copilot Chat History extension!');
    });

    const searchCommand = safeRegister('copilotChatHistory.search', async () => {
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

    const clearFilterCommand = safeRegister('copilotChatHistory.clearFilter', () => {
        chatHistoryProvider.clearFilter();
        vscode.window.showInformationMessage('Filter cleared');
    });

    const openWorkspaceInCurrentWindowCommand = safeRegister('copilotChatHistory.openWorkspaceInCurrentWindow', async (workspaceGroup: WorkspaceGroup) => {
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

    const openWorkspaceInNewWindowCommand = safeRegister('copilotChatHistory.openWorkspaceInNewWindow', async (workspaceGroup: WorkspaceGroup) => {
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

    // Helper: warn when background scan is in progress
    async function confirmActionDuringScan(): Promise<boolean> {
        try {
            if (chatHistoryProvider.isScanning()) {
                const choice = await vscode.window.showWarningMessage(
                    'Background scan is in progress. Wait for scan to complete or proceed with the action? This may operate on incomplete data.',
                    { modal: true },
                    'Wait',
                    'Proceed'
                );
                return choice === 'Proceed';
            }
            return true;
        } catch (err) {
            return true;
        }
    }

    const exportWorkspaceConversationsCommand = safeRegister('copilotChatHistory.exportWorkspaceConversations', async (workspaceGroup: WorkspaceGroup) => {
        try {
            if (!(await confirmActionDuringScan())) return;
            const folderUris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                openLabel: 'Select export folder'
            });

            if (!folderUris || folderUris.length === 0) {
                return;
            }

            const folderUri = folderUris[0];
            if (folderUri.scheme !== 'file') {
                showCentralizedError(
                    'Only file system folders are supported for exporting conversations.',
                    'exportWorkspaceConversations:unsupportedScheme'
                );
                return;
            }

            const destFolder = folderUri.fsPath;
            try {
                await fs.promises.mkdir(destFolder, { recursive: true });
            } catch {
                // ignore
            }

            let exported = 0;
            const errors: string[] = [];
            const sessions = workspaceGroup.sessions || [];

            // Show a progress notification while exporting
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Exporting ${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} from ${workspaceGroup.workspaceName}`,
                    cancellable: true
                },
                async (progress, token) => {
                    if (sessions.length === 0) {
                        progress.report({ message: 'No conversations to export', increment: 100 });
                        return;
                    }

                    let cancelled = false;

                    for (let i = 0; i < sessions.length; i++) {
                        if (token.isCancellationRequested) {
                            cancelled = true;
                            progress.report({ message: 'Cancelled by user' });
                            break;
                        }

                        const session = sessions[i];
                        progress.report({ message: `Exporting ${sanitizeFileName(session.customTitle || session.id)} (${i + 1}/${sessions.length})` });

                        try {
                            const { data } = await loadSessionData(session);
                            const fileName = `${sanitizeFileName(session.customTitle || session.id)}-${session.id}.json`;
                            const outPath = path.join(destFolder, fileName);
                            await fs.promises.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');
                            exported++;
                        } catch (error) {
                            if (error instanceof SessionFileError) {
                                logSessionFileError('exportWorkspaceConversations', error);
                                errors.push(`Failed to export ${session.id}: ${error.message}`);
                            } else {
                                console.error('Error exporting session:', error);
                                errors.push(`Failed to export ${session.id}: unexpected error`);
                            }
                        }

                        // Report incremental progress
                        const increment = Math.round(100 / sessions.length * 100) / 100; // two decimal precision
                        progress.report({ increment });
                    }

                    // Post-progress notification for cancellation
                    if (cancelled) {
                        vscode.window.showWarningMessage(`Export cancelled: ${exported} succeeded, ${sessions.length - exported} skipped.`);
                    }
                }
            );

            // Final notification depending on result
            if (errors.length > 0) {
                const failed = errors.length;
                vscode.window.showErrorMessage(`Export completed with errors: ${exported} succeeded, ${failed} failed. See logs for details.`);
            } else {
                vscode.window.showInformationMessage(`Export complete: ${exported} conversation${exported !== 1 ? 's' : ''} exported to ${destFolder}`);
            }
        } catch (error) {
            console.error('Error exporting workspace conversations:', error);
            showCentralizedError('Error exporting workspace conversations: see logs for details.', 'exportWorkspaceConversations:unexpected');
        }
    });

    // Export selected conversations (multi-select)
    const exportSelectedConversationsCommand = safeRegister('copilotChatHistory.exportSelectedConversations', async () => {
        try {
            if (!(await confirmActionDuringScan())) return;
            const selections = chatTreeView.selection.filter(s => !('sessions' in s)) as ChatSession[];
            if (!selections || selections.length === 0) {
                vscode.window.showInformationMessage('No conversations selected to export.');
                return;
            }

            const folderUris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                openLabel: 'Select export folder'
            });

            if (!folderUris || folderUris.length === 0) {
                return;
            }

            const folderUri = folderUris[0];
            if (folderUri.scheme !== 'file') {
                showCentralizedError(
                    'Only file system folders are supported for exporting conversations.',
                    'exportSelectedConversations:unsupportedScheme'
                );
                return;
            }

            const destFolder = folderUri.fsPath;
            try {
                await fs.promises.mkdir(destFolder, { recursive: true });
            } catch {
                // ignore
            }

            let exported = 0;
            const errors: string[] = [];

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Exporting ${selections.length} selected conversation${selections.length !== 1 ? 's' : ''}`,
                    cancellable: true
                },
                async (progress, token) => {
                    let cancelled = false;
                    for (let i = 0; i < selections.length; i++) {
                        if (token.isCancellationRequested) {
                            cancelled = true;
                            progress.report({ message: 'Cancelled by user' });
                            break;
                        }

                        const session = selections[i];
                        progress.report({ message: `Exporting ${sanitizeFileName(session.customTitle || session.id)} (${i + 1}/${selections.length})` });
                        try {
                            const { data } = await loadSessionData(session);
                            const fileName = `${sanitizeFileName(session.customTitle || session.id)}-${session.id}.json`;
                            const outPath = path.join(destFolder, fileName);
                            await fs.promises.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');
                            exported++;
                        } catch (error) {
                            if (error instanceof SessionFileError) {
                                logSessionFileError('exportSelectedConversations', error);
                                errors.push(`Failed to export ${session.id}: ${error.message}`);
                            } else {
                                console.error('Error exporting session:', error);
                                errors.push(`Failed to export ${session.id}: unexpected error`);
                            }
                        }

                        const increment = Math.round(100 / selections.length * 100) / 100;
                        progress.report({ increment });
                    }

                    if (cancelled) {
                        vscode.window.showWarningMessage(`Export cancelled: ${exported} succeeded, ${selections.length - exported} skipped.`);
                    }
                }
            );

            if (errors.length > 0) {
                vscode.window.showErrorMessage(`Export completed with errors: ${exported} succeeded, ${errors.length} failed. See logs.`);
            } else {
                vscode.window.showInformationMessage(`Export complete: ${exported} conversation${exported !== 1 ? 's' : ''} exported to ${destFolder}`);
            }
        } catch (error) {
            console.error('Error exporting selected conversations:', error);
            showCentralizedError('Error exporting selected conversations: see logs for details.', 'exportSelectedConversations:unexpected');
        }
    });

    // Delete selected conversations (multi-select)
    const deleteSelectedConversationsCommand = safeRegister('copilotChatHistory.deleteSelectedConversations', async () => {
        try {
            if (!(await confirmActionDuringScan())) return;
            const selections = chatTreeView.selection.filter(s => !('sessions' in s)) as ChatSession[];
            if (!selections || selections.length === 0) {
                vscode.window.showInformationMessage('No conversations selected to delete.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete ${selections.length} selected conversation${selections.length !== 1 ? 's' : ''}? This cannot be undone.`,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') {
                return;
            }

            let deleted = 0;
            const errors: string[] = [];

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Deleting ${selections.length} conversation${selections.length !== 1 ? 's' : ''}`,
                    cancellable: true
                },
                async (progress, token) => {
                    let cancelled = false;
                    const movedEntries: ArchiveEntry[] = [];

                    for (let i = 0; i < selections.length; i++) {
                        if (token.isCancellationRequested) {
                            cancelled = true;
                            progress.report({ message: 'Cancelled by user' });
                            break;
                        }

                        const session = selections[i];
                        progress.report({ message: `Deleting ${sanitizeFileName(session.customTitle || session.id)} (${i + 1}/${selections.length})` });
                        try {
                            const entry = await moveSessionToArchive(context, session, chatHistoryProvider);
                            movedEntries.push(entry);
                            deleted++;
                        } catch (error) {
                            if (error instanceof SessionFileError) {
                                logSessionFileError('deleteSelectedConversations', error);
                                errors.push(`Failed to delete ${session.id}: ${error.message}`);
                            } else {
                                console.error('Error deleting session:', error);
                                errors.push(`Failed to delete ${session.id}: unexpected error`);
                            }
                        }

                        const increment = Math.round(100 / selections.length * 100) / 100;
                        progress.report({ increment });
                    }

                    if (cancelled) {
                        vscode.window.showWarningMessage(`Deletion cancelled: ${deleted} succeeded, ${selections.length - deleted} skipped.`);
                    }

                    // Offer undo for the moved entries
                    if (movedEntries.length > 0) {
                        const undo = 'Undo';
                        const msg = `Deleted ${deleted} conversation${deleted !== 1 ? 's' : ''}.`;
                        const choice = await vscode.window.showInformationMessage(msg, undo);
                        if (choice === undo) {
                            await restoreArchivedEntries(movedEntries);
                            chatHistoryProvider.refresh();
                            archiveProvider.refresh();
                            vscode.window.showInformationMessage('Deletion undone. Files restored.');
                        }
                    }
                }
            );

            // Refresh view
            chatHistoryProvider.refresh();
            archiveProvider.refresh();

            if (errors.length > 0) {
                vscode.window.showErrorMessage(`Deletion completed with errors: ${deleted} succeeded, ${errors.length} failed. See logs.`);
            } else {
                vscode.window.showInformationMessage(`Deleted ${deleted} conversation${deleted !== 1 ? 's' : ''}.`);
            }
        } catch (error) {
            console.error('Error deleting selected conversations:', error);
            showCentralizedError('Error deleting selected conversations: see logs for details.', 'deleteSelectedConversations:unexpected');
        }
    });

    // Delete a single conversation
    const deleteConversationCommand = safeRegister('copilotChatHistory.deleteConversation', async (session: ChatSession) => {
        try {
            const confirm = await vscode.window.showWarningMessage(
                `Archive conversation "${session.customTitle || session.id}"? (Archives to extension archive and removes from history view)`,
                { modal: true },
                'Archive'
            );

            if (confirm !== 'Archive') {
                return;
            }

            try {
                const entry = await moveSessionToArchive(context, session, chatHistoryProvider);
                chatHistoryProvider.refresh();
                archiveProvider.refresh();
                const undo = 'Undo';
                const choice = await vscode.window.showInformationMessage(`Archived conversation ${session.id}`, undo);
                if (choice === undo) {
                    await restoreArchivedEntries([entry]);
                    chatHistoryProvider.refresh();
                    archiveProvider.refresh();
                    vscode.window.showInformationMessage('Archive undone. File restored.');
                }
            } catch (error) {
                if (error instanceof SessionFileError) {
                    handleSessionFileError('deleteConversation', error);
                    return;
                }
                console.error('Error archiving conversation:', error);
                showCentralizedError('Error archiving conversation: see logs for details.', 'deleteConversation:unexpected');
            }
        } catch (error) {
            console.error('Error in deleteConversation handler:', error);
            showCentralizedError('Error archiving conversation: see logs for details.', 'deleteConversation:unexpected');
        }
    });

    // Delete conversation permanently (send to OS recycle bin)
    const deleteConversationPermanentlyCommand = safeRegister('copilotChatHistory.deleteConversationPermanently', async (session: ChatSession) => {
        try {
            const confirm = await vscode.window.showWarningMessage(
                `Delete conversation "${session.customTitle || session.id}" permanently? This will send it to the OS Recycle Bin and cannot be undone from the extension.`,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') return;

            try {
                const sessionPath = await resolveSessionFilePath(session);
                await trash([sessionPath]);
                chatHistoryProvider.refresh();
                vscode.window.showInformationMessage(`Conversation ${session.id} sent to Recycle Bin.`);
                // Telemetry placeholder
                console.info('telemetry:deletePermanent', { sessionId: session.id, workspace: session.workspaceName });
            } catch (error) {
                if (error instanceof SessionFileError) {
                    handleSessionFileError('deleteConversationPermanently', error);
                    return;
                }
                console.error('Error deleting conversation permanently:', error);
                showCentralizedError('Error deleting conversation: see logs for details.', 'deleteConversationPermanently:unexpected');
            }
        } catch (error) {
            console.error('Error in deleteConversationPermanently handler:', error);
            showCentralizedError('Error deleting conversation: see logs for details.', 'deleteConversationPermanently:unexpected');
        }
    });

    // Delete all conversations in a workspace (Archive)
    const deleteWorkspaceConversationsCommand = safeRegister('copilotChatHistory.deleteWorkspaceConversations', async (workspaceGroup: WorkspaceGroup) => {

        // Existing archive behavior preserved
        try {
            if (!(await confirmActionDuringScan())) return;
            const sessions = workspaceGroup.sessions || [];
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No conversations found in workspace.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete all ${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} in workspace "${workspaceGroup.workspaceName}"? This cannot be undone.`,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') {
                return;
            }

            let deleted = 0;
            const errors: string[] = [];

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Deleting ${sessions.length} conversations in ${workspaceGroup.workspaceName}`,
                    cancellable: true
                },
                async (progress, token) => {
                    let cancelled = false;
                    const movedEntries: ArchiveEntry[] = [];

                    for (let i = 0; i < sessions.length; i++) {
                        if (token.isCancellationRequested) {
                            cancelled = true;
                            progress.report({ message: 'Cancelled by user' });
                            break;
                        }

                        const session = sessions[i];
                        progress.report({ message: `Deleting ${sanitizeFileName(session.customTitle || session.id)} (${i + 1}/${sessions.length})` });
                        try {
                            const entry = await moveSessionToArchive(context, session, chatHistoryProvider);
                            movedEntries.push(entry);
                            deleted++;
                        } catch (error) {
                            if (error instanceof SessionFileError) {
                                logSessionFileError('deleteWorkspaceConversations', error);
                                errors.push(`Failed to delete ${session.id}: ${error.message}`);
                            } else {
                                console.error('Error deleting session:', error);
                                errors.push(`Failed to delete ${session.id}: unexpected error`);
                            }
                        }

                        const increment = Math.round(100 / sessions.length * 100) / 100;
                        progress.report({ increment });
                    }

                    if (cancelled) {
                        vscode.window.showWarningMessage(`Deletion cancelled: ${deleted} succeeded, ${sessions.length - deleted} skipped.`);
                    }

                    if (movedEntries.length > 0) {
                        const undo = 'Undo';
                        const choice = await vscode.window.showInformationMessage(`Deleted ${deleted} conversation${deleted !== 1 ? 's' : ''} from ${workspaceGroup.workspaceName}`, undo);
                        if (choice === undo) {
                            await restoreArchivedEntries(movedEntries);
                            chatHistoryProvider.refresh();
                            archiveProvider.refresh();
                            vscode.window.showInformationMessage('Deletion undone. Files restored.');
                        }
                    }
                }
            );

            chatHistoryProvider.refresh();
            archiveProvider.refresh();

            if (errors.length > 0) {
                vscode.window.showErrorMessage(`Deletion completed with errors: ${deleted} succeeded, ${errors.length} failed. See logs.`);
            } else {
                vscode.window.showInformationMessage(`Deleted ${deleted} conversation${deleted !== 1 ? 's' : ''} from ${workspaceGroup.workspaceName}`);
            }
        } catch (error) {
            console.error('Error deleting workspace conversations:', error);
            showCentralizedError('Error deleting workspace conversations: see logs for details.', 'deleteWorkspaceConversations:unexpected');
        }
    });

    // Delete workspace conversations permanently (send to OS recycle bin)
    const deleteWorkspaceConversationsPermanentlyCommand = safeRegister('copilotChatHistory.deleteWorkspaceConversationsPermanently', async (workspaceGroup: WorkspaceGroup) => {
        try {
            const sessions = workspaceGroup.sessions || [];
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No conversations found in workspace.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete all ${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} in workspace "${workspaceGroup.workspaceName}"? This will send files to the OS Recycle Bin and cannot be undone from the extension.`,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') {
                return;
            }

            let deleted = 0;
            const errors: string[] = [];

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Permanently deleting ${sessions.length} conversations in ${workspaceGroup.workspaceName}`,
                    cancellable: true
                },
                async (progress, token) => {
                    let cancelled = false;
                    for (let i = 0; i < sessions.length; i++) {
                        if (token.isCancellationRequested) {
                            cancelled = true;
                            progress.report({ message: 'Cancelled by user' });
                            break;
                        }

                        const session = sessions[i];
                        progress.report({ message: `Deleting ${sanitizeFileName(session.customTitle || session.id)} (${i + 1}/${sessions.length})` });
                        try {
                            const sessionPath = await resolveSessionFilePath(session);
                            await trash([sessionPath]);
                            // Remove from cache
                            chatHistoryProvider.cachedSessions = chatHistoryProvider.cachedSessions.filter(s => s.id !== session.id);
                            deleted++;
                        } catch (error) {
                            if (error instanceof SessionFileError) {
                                logSessionFileError('deleteWorkspaceConversationsPermanently', error);
                                errors.push(`Failed to delete ${session.id}: ${error.message}`);
                            } else {
                                console.error('Error deleting session permanently:', error);
                                errors.push(`Failed to delete ${session.id}: unexpected error`);
                            }
                        }

                        const increment = Math.round(100 / sessions.length * 100) / 100;
                        progress.report({ increment });
                    }

                    if (cancelled) {
                        vscode.window.showWarningMessage(`Deletion cancelled: ${deleted} succeeded, ${sessions.length - deleted} skipped.`);
                    }
                }
            );

            chatHistoryProvider.refresh();
            archiveProvider.refresh();

            if (errors.length > 0) {
                vscode.window.showErrorMessage(`Deletion completed with errors: ${deleted} succeeded, ${errors.length} failed. See logs.`);
            } else {
                vscode.window.showInformationMessage(`Deleted ${deleted} conversation${deleted !== 1 ? 's' : ''} from ${workspaceGroup.workspaceName}`);
            }
        } catch (error) {
            console.error('Error deleting workspace conversations permanently:', error);
            showCentralizedError('Error deleting workspace conversations: see logs for details.', 'deleteWorkspaceConversationsPermanently:unexpected');
        }
    });


    // Restore archived session
    const restoreArchivedSessionCommand = safeRegister('copilotChatHistory.restoreArchivedSession', async (archived: { filePath: string }) => {
        try {
            const metaPath = archived.filePath + '.meta.json';
            let originalPath: string | undefined;
            let sessionId: string | undefined;
            try {
                if (fs.existsSync(metaPath)) {
                    const metaRaw = await fs.promises.readFile(metaPath, 'utf8');
                    const meta = JSON.parse(metaRaw);
                    originalPath = meta.originalPath;
                    sessionId = meta.sessionId;
                }
            } catch (err) {
                // ignore
            }

            if (!originalPath) {
                const chosen = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    openLabel: 'Select destination folder to restore to'
                });
                if (!chosen || chosen.length === 0) return;
                originalPath = path.join(chosen[0].fsPath, path.basename(archived.filePath));
            }

            await moveFileTo(originalPath, archived.filePath);
            try { if (fs.existsSync(metaPath)) await fs.promises.unlink(metaPath); } catch {}
            
            // Force reload the restored session into cache
            try {
                const stats = fs.statSync(originalPath);
                const raw = fs.readFileSync(originalPath, 'utf8');
                const sessionData = JSON.parse(raw);
                const messageCount = sessionData.requests ? sessionData.requests.length : 0;
                let customTitle = sessionData.customTitle;
                if (!customTitle && sessionData.requests && sessionData.requests.length > 0) {
                    const firstRequest = sessionData.requests[0];
                    if (firstRequest && firstRequest.message && firstRequest.message.text) {
                        customTitle = firstRequest.message.text.replace(/\n/g, ' ').trim().substring(0, 50);
                        if (firstRequest.message.text.length > 50) customTitle += '...';
                    }
                }
                
                // Determine workspace info from path
                const chatSessionsPath = path.dirname(originalPath);
                const workspaceDir = path.dirname(chatSessionsPath);
                let workspaceName = 'Unknown';
                let workspacePath: string | undefined;
                const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
                if (fs.existsSync(workspaceJsonPath)) {
                    try {
                        const workspaceData = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
                        if (workspaceData.folder) {
                            workspacePath = chatHistoryProvider.uriToPath(workspaceData.folder);
                            if (workspacePath) workspaceName = path.basename(workspacePath);
                        }
                    } catch (err) {}
                }
                
                const restoredSession: ChatSession = {
                    id: path.basename(originalPath, '.json'),
                    customTitle,
                    workspaceName,
                    workspacePath,
                    lastModified: stats.mtime,
                    filePath: originalPath,
                    messageCount,
                    storageRoot: chatSessionsPath
                };
                
                // Add to cache
                chatHistoryProvider.cachedSessions.push(restoredSession);
            } catch (err) {
                console.error('Error loading restored session into cache:', err);
            }
            
            // Add to skip-auto-archive list if we know the session ID
            if (sessionId) {
                await addToSkipAutoArchive(sessionId);
                // Auto-remove from skip list after 5 minutes (300000ms) - gives user time to see it before auto-archive runs
                setTimeout(async () => {
                    await removeFromSkipAutoArchive(sessionId);
                }, 300000);
            }
            
            // Remove workspace directory if it's now empty
            const archiveWorkspacePath = path.dirname(archived.filePath);
            await removeEmptyArchiveWorkspace(archiveWorkspacePath);
            
            // Refresh both views immediately
            chatHistoryProvider.refresh();
            archiveProvider.refresh();
            vscode.window.showInformationMessage('Archived conversation restored.');
        } catch (err) {
            console.error('Error restoring archived session', err);
            showCentralizedError('Error restoring archived session: see logs for details.', 'restoreArchivedSession:unexpected');
        }
    });

    // Delete archived session permanently
    const deleteArchivedSessionCommand = safeRegister('copilotChatHistory.deleteArchivedSession', async (archived: { filePath: string, fileName?: string }) => {
        try {
            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete archived file "${archived.fileName || path.basename(archived.filePath)}"? This cannot be undone.`,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') return;

            try {
                const workspacePath = path.dirname(archived.filePath);
                await fs.promises.unlink(archived.filePath);
                const metaPath = archived.filePath + '.meta.json';
                try { if (fs.existsSync(metaPath)) await fs.promises.unlink(metaPath); } catch {}
                
                // Remove workspace directory if it's now empty
                await removeEmptyArchiveWorkspace(workspacePath);
                
                archiveProvider.refresh();
                vscode.window.showInformationMessage('Archived file deleted permanently.');
            } catch (err) {
                console.error('Error deleting archived file:', err);
                showCentralizedError('Error deleting archived file: see logs for details.', 'deleteArchivedSession:unexpected');
            }
        } catch (err) {
            console.error('Error in deleteArchivedSession handler:', err);
            showCentralizedError('Error deleting archived file: see logs for details.', 'deleteArchivedSession:unexpected');
        }
    });

    // Empty Archive (global or per-workspace) with retention policy
    const emptyArchiveCommand = safeRegister('copilotChatHistory.emptyArchive', async () => {
        // existing implementation (unchanged)
        try {
            const archiveRoot = path.join(context.globalStorageUri.fsPath, 'archive');
            if (!fs.existsSync(archiveRoot)) {
                vscode.window.showInformationMessage('Archive is empty.');
                return;
            }

            const groups = fs.readdirSync(archiveRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
            const scopeOptions = ['All archives', ...groups];
            const scope = await vscode.window.showQuickPick(scopeOptions, { placeHolder: 'Choose archive scope to empty' });
            if (!scope) return;

            const retentionOpt = await vscode.window.showQuickPick(['Delete all now', 'Delete older than N days', 'Cancel'], { placeHolder: 'Choose retention option' });
            if (!retentionOpt || retentionOpt === 'Cancel') return;

            let cutoff: number | undefined;
            if (retentionOpt === 'Delete older than N days') {
                const daysStr = await vscode.window.showInputBox({ prompt: 'Enter number of days (e.g., 30)', value: '30' });
                if (!daysStr) return;
                const days = parseInt(daysStr, 10);
                if (isNaN(days) || days <= 0) {
                    vscode.window.showErrorMessage('Invalid number of days');
                    return;
                }
                cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            }

            // Build list of files to delete
            const targetDirs = scope === 'All archives' ? groups.map(g => path.join(archiveRoot, g)) : [path.join(archiveRoot, scope)];
            const filesToDelete: string[] = [];
            for (const dir of targetDirs) {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.json'));
                for (const f of files) {
                    const fp = path.join(dir, f.name);
                    if (cutoff) {
                        const stats = fs.statSync(fp);
                        if (stats.mtime.getTime() < cutoff) {
                            filesToDelete.push(fp);
                        }
                    } else {
                        filesToDelete.push(fp);
                    }
                }
            }

            if (filesToDelete.length === 0) {
                vscode.window.showInformationMessage('No archived files matched the criteria.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete ${filesToDelete.length} archived file${filesToDelete.length !== 1 ? 's' : ''}? This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') return;

            let deleted = 0;
            let cancelled = false;

            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Emptying archive (${filesToDelete.length} files)`, cancellable: true }, async (progress, token) => {
                for (let i = 0; i < filesToDelete.length; i++) {
                    if (token.isCancellationRequested) { cancelled = true; break; }
                    const fp = filesToDelete[i];
                    try {
                        await fs.promises.unlink(fp);
                        const meta = fp + '.meta.json';
                        try { if (fs.existsSync(meta)) await fs.promises.unlink(meta); } catch {}
                        deleted++;
                    } catch (err) {
                        console.error('Error deleting archived file:', fp, err);
                    }
                    const inc = Math.round(100 / filesToDelete.length * 100) / 100;
                    progress.report({ increment: inc, message: `${i + 1}/${filesToDelete.length}` });
                }
            });

            // Clean up empty workspace directories
            for (const dir of targetDirs) {
                await removeEmptyArchiveWorkspace(dir);
            }

            archiveProvider.refresh();

            if (cancelled) {
                vscode.window.showWarningMessage(`Archive emptying cancelled: ${deleted} deleted, ${filesToDelete.length - deleted} skipped.`);
            } else {
                vscode.window.showInformationMessage(`Archive cleaned: ${deleted} files deleted.`);
            }
        } catch (err) {
            console.error('Error emptying archive:', err);
            showCentralizedError('Error emptying archive: see logs for details.', 'emptyArchive:unexpected');
        }
    });

    // Purge archives older than N days (helper used both interactively and by schedule)
    async function purgeArchiveOlderThan(days: number) {
        try {
            const archiveRoot = path.join(context.globalStorageUri.fsPath, 'archive');
            if (!fs.existsSync(archiveRoot)) return;

            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            const groups = fs.readdirSync(archiveRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(archiveRoot, d.name));
            let deletedCount = 0;

            for (const dir of groups) {
                const files = fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.json'));
                for (const f of files) {
                    const fp = path.join(dir, f.name);
                    try {
                        const stats = fs.statSync(fp);
                        if (stats.mtime.getTime() < cutoff) {
                            await fs.promises.unlink(fp);
                            const meta = fp + '.meta.json';
                            try { if (fs.existsSync(meta)) await fs.promises.unlink(meta); } catch {}
                            deletedCount++;
                        }
                    } catch (err) {
                        console.error('Error purging archived file:', fp, err);
                    }
                }
            }

            if (deletedCount > 0) {
                archiveProvider.refresh();
                console.info('telemetry:purge', { action: 'scheduledPurge', days, deleted: deletedCount });
            }
        } catch (err) {
            console.error('Error in scheduled purge:', err);
        }
    }

    // Skip-auto-archive tracking: store session IDs to skip during auto-archive
    const skipAutoArchiveKey = 'skipAutoArchiveSessionIds';
    
    async function addToSkipAutoArchive(sessionId: string): Promise<void> {
        const skipList = context.globalState.get<string[]>(skipAutoArchiveKey) || [];
        if (!skipList.includes(sessionId)) {
            skipList.push(sessionId);
            await context.globalState.update(skipAutoArchiveKey, skipList);
        }
    }
    
    async function removeFromSkipAutoArchive(sessionId: string): Promise<void> {
        let skipList = context.globalState.get<string[]>(skipAutoArchiveKey) || [];
        skipList = skipList.filter(id => id !== sessionId);
        await context.globalState.update(skipAutoArchiveKey, skipList);
    }
    
    async function isSkipAutoArchive(sessionId: string): Promise<boolean> {
        const skipList = context.globalState.get<string[]>(skipAutoArchiveKey) || [];
        return skipList.includes(sessionId);
    }
    
    // Clean stale entries from skip list (sessions that no longer exist)
    async function cleanupSkipAutoArchiveList(): Promise<void> {
        try {
            const skipList = context.globalState.get<string[]>(skipAutoArchiveKey) || [];
            if (skipList.length === 0) return;
            
            const allSessions = await chatHistoryProvider.listAllChatSessions(true);
            const existingIds = new Set(allSessions.map(s => s.id));
            
            const cleanedList = skipList.filter(id => existingIds.has(id));
            if (cleanedList.length !== skipList.length) {
                await context.globalState.update(skipAutoArchiveKey, cleanedList);
                console.info('Cleaned up skip-auto-archive list:', skipList.length - cleanedList.length, 'stale entries removed');
            }
        } catch (err) {
            console.error('Error cleaning skip-auto-archive list:', err);
        }
    }

    // Auto-archive: check workspace session counts and archive or permanently delete oldest
    async function runAutoArchiveNow() {
        try {
            const config = vscode.workspace.getConfiguration();
            const enabled = config.get<boolean>('copilotChatHistory.autoArchive.enabled');
            if (!enabled) return;
            const maxSessions = config.get<number>('copilotChatHistory.autoArchive.maxSessions') || 200;
            const action = config.get<string>('copilotChatHistory.autoArchive.action') || 'archive';
            const scope = config.get<string>('copilotChatHistory.autoArchive.scope') || 'allWorkspaces';

            // Force refresh from disk to get accurate count
            let sessions = await chatHistoryProvider.listAllChatSessions(true);
            // If scope is currentWorkspace, filter to active workspace only
            if (scope === 'currentWorkspace') {
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length > 0) {
                    const current = path.basename(folders[0].uri.fsPath);
                    sessions = sessions.filter(s => (s.workspacePath && path.basename(s.workspacePath) === current) || s.workspaceName === current);
                } else {
                    // No open workspace, nothing to do
                    return;
                }
            }
            // Group by workspace
            const byWorkspace = new Map<string, ChatSession[]>();
            for (const s of sessions) {
                const key = s.workspaceName || 'unknown';
                const arr = byWorkspace.get(key) || [];
                arr.push(s);
                byWorkspace.set(key, arr);
            }

            const workspacesToProcess: { workspaceName: string; toProcess: ChatSession[] }[] = [];
            for (const [workspaceName, arr] of byWorkspace.entries()) {
                if (arr.length > maxSessions) {
                    const sorted = arr.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime()); // oldest first
                    const overflow = sorted.slice(0, arr.length - maxSessions);
                    workspacesToProcess.push({ workspaceName, toProcess: overflow });
                }
            }

            if (workspacesToProcess.length === 0) {
                console.info('Auto-archive: nothing to do');
                return;
            }

            let totalProcessed = 0;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Auto-archive: managing overflow', cancellable: true }, async (progress, token) => {
                for (const ws of workspacesToProcess) {
                    if (token.isCancellationRequested) break;
                    const arr = ws.toProcess;
                    for (let i = 0; i < arr.length; i++) {
                        if (token.isCancellationRequested) break;
                        const s = arr[i];
                        
                        // Skip if user explicitly unarchived this session
                        if (await isSkipAutoArchive(s.id)) {
                            console.info('Auto-archive: skipping', s.id, '(user unarchived recently)');
                            continue;
                        }
                        try {
                            if (action === 'delete') {
                                const p = await resolveSessionFilePath(s);
                                await trash([p]);
                                console.info('telemetry:autoArchive', { action: 'delete', sessionId: s.id, workspace: ws.workspaceName });
                            } else {
                                await moveSessionToArchive(context, s);
                                console.info('telemetry:autoArchive', { action: 'archive', sessionId: s.id, workspace: ws.workspaceName });
                            }
                            totalProcessed++;
                        } catch (err) {
                            console.error('Auto-archive: failed for', s.id, err);
                        }
                        progress.report({ message: `${ws.workspaceName}: ${i + 1}/${arr.length}` });
                    }
                }
            });

            if (totalProcessed > 0) {
                // Record the auto-archive run time
                archiveProvider.setLastAutoArchiveTime(Date.now());
                chatHistoryProvider.refresh();
                archiveProvider.refresh();
                vscode.window.showInformationMessage(`Auto-archive processed ${totalProcessed} conversation${totalProcessed !== 1 ? 's' : ''}.`);
            } else {
                // Even if nothing was processed, update the status to show the run completed
                archiveProvider.setLastAutoArchiveTime(Date.now());
                archiveProvider.refresh();
            }
        } catch (err) {
            console.error('Error running auto-archive:', err);
            showCentralizedError('Error running auto-archive: see logs for details.', 'runAutoArchiveNow:unexpected');
        }
    }

    context.subscriptions.push(restoreArchivedSessionCommand, deleteArchivedSessionCommand, emptyArchiveCommand, deleteConversationPermanentlyCommand, deleteWorkspaceConversationsPermanentlyCommand);

    // Auto-purge and Auto-archive scheduling with optional leader election and multi-workspace monitoring
    const config = vscode.workspace.getConfiguration();

    // Create a status bar item to show scanning / master state
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBar);

    // Load cached sessions first for immediate UI responsiveness, then start background scan
    chatHistoryProvider.loadCache(context).then(() => {
        chatHistoryProvider.refresh(); // Refresh with cached data
        
        // Then start background scan to update with fresh data
        chatHistoryProvider.startBackgroundScan(context, (msg) => {
            if (msg) {
                statusBar.text = `Copilot: ${msg}`;
                statusBar.show();
            } else {
                statusBar.hide();
            }
        });
        
        // Periodically clean up stale entries from skip-auto-archive list (every hour)
        setInterval(() => {
            cleanupSkipAutoArchiveList();
        }, 60 * 60 * 1000);
    });

    // Leader election helpers (use lock file in global storage)
    const instanceId = (crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : `${process.pid}-${Date.now()}`;
    const lockPath = path.join(context.globalStorageUri.fsPath, 'autoArchive.lock.json');
    let isMaster = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let scheduledAutoArchiveTimer: NodeJS.Timeout | undefined;
    let scheduledPurgeTimer: NodeJS.Timeout | undefined;
    let lockMonitorTimer: NodeJS.Timeout | undefined;

    async function readLock(): Promise<{ ownerId: string; lastHeartbeat: number } | null> {
        try {
            if (!fs.existsSync(lockPath)) return null;
            const raw = await fs.promises.readFile(lockPath, 'utf8');
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    async function writeLock(ownerId: string) {
        try {
            const payload = { ownerId, lastHeartbeat: Date.now() };
            await ensureDir(path.dirname(lockPath));
            await fs.promises.writeFile(lockPath, JSON.stringify(payload), 'utf8');
        } catch (err) {
            console.error('Error writing lock file:', err);
        }
    }

    async function tryAcquireMaster(lockTTLSeconds: number): Promise<boolean> {
        try {
            const current = await readLock();
            if (!current) {
                await writeLock(instanceId);
                // Re-read to ensure
                const now = await readLock();
                if (now && now.ownerId === instanceId) return true;
                return false;
            }

            const age = Date.now() - (current.lastHeartbeat || 0);
            if (age > (lockTTLSeconds * 1000)) {
                // Consider expired, try to claim
                await writeLock(instanceId);
                const now = await readLock();
                if (now && now.ownerId === instanceId) return true;
            }
            return false;
        } catch (err) {
            console.error('Error during tryAcquireMaster:', err);
            return false;
        }
    }

    async function startMasterHeartbeat(heartbeatIntervalSeconds: number) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(async () => {
            try {
                const lock = await readLock();
                if (lock && lock.ownerId === instanceId) {
                    await writeLock(instanceId); // refresh
                }
            } catch (err) {
                console.error('Heartbeat error:', err);
            }
        }, heartbeatIntervalSeconds * 1000);
    }

    function stopMasterHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    }

    async function startAsMaster() {
        if (isMaster) return;
        isMaster = true;
        statusBar.text = 'Copilot: master monitor';
        statusBar.show();

        // Start scheduled purge if enabled
        if (config.get('copilotChatHistory.autoPurge.enabled')) {
            const days = config.get<number>('copilotChatHistory.autoPurge.days') || 90;
            const hours = config.get<number>('copilotChatHistory.autoPurge.checkIntervalHours') || 24;
            // run immediately
            await purgeArchiveOlderThan(days);
            scheduledPurgeTimer = setInterval(async () => {
                await purgeArchiveOlderThan(days);
                console.info('telemetry:purge', { action: 'autoPurgeRun', days });
            }, (hours || 24) * 60 * 60 * 1000);
        }

        // Start scheduled auto-archive
        if (config.get('copilotChatHistory.autoArchive.enabled')) {
            const hours = config.get<number>('copilotChatHistory.autoArchive.checkIntervalHours') || 24;
            // Run once immediately
            (async () => {
                await runAutoArchiveNow();
                console.info('telemetry:autoArchive', { action: 'initialRun' });
            })();
            scheduledAutoArchiveTimer = setInterval(async () => {
                await runAutoArchiveNow();
                console.info('telemetry:autoArchive', { action: 'scheduledRun' });
            }, (hours || 24) * 60 * 60 * 1000);
        }
    }

    async function stopBeingMaster() {
        isMaster = false;
        statusBar.hide();
        if (scheduledAutoArchiveTimer) { clearInterval(scheduledAutoArchiveTimer); scheduledAutoArchiveTimer = undefined; }
        if (scheduledPurgeTimer) { clearInterval(scheduledPurgeTimer); scheduledPurgeTimer = undefined; }
        stopMasterHeartbeat();
    }

    // Monitor the lock and try to become master when available
    async function monitorLockLoop() {
        const enabled = config.get<boolean>('copilotChatHistory.autoArchive.leaderElectionEnabled');
        const scope = config.get<string>('copilotChatHistory.autoArchive.scope') || 'allWorkspaces';
        const lockTTL = config.get<number>('copilotChatHistory.autoArchive.lockTTLSeconds') || 120;
        const heartbeatInterval = config.get<number>('copilotChatHistory.autoArchive.heartbeatIntervalSeconds') || 30;

        if (!enabled || scope === 'currentWorkspace') {
            // Do not attempt distributed leadership; run local scheduling for current workspace only
            console.info('Auto-archive leader election disabled or scope set to currentWorkspace — using local scheduling');
            if (config.get('copilotChatHistory.autoArchive.enabled')) {
                const hours = config.get<number>('copilotChatHistory.autoArchive.checkIntervalHours') || 24;
                scheduledAutoArchiveTimer = setInterval(async () => {
                    await runAutoArchiveNow();
                    console.info('telemetry:autoArchive', { action: 'scheduledRunLocal' });
                }, (hours || 24) * 60 * 60 * 1000);
            }
            if (config.get('copilotChatHistory.autoPurge.enabled')) {
                const days = config.get<number>('copilotChatHistory.autoPurge.days') || 90;
                const hours = config.get<number>('copilotChatHistory.autoPurge.checkIntervalHours') || 24;
                scheduledPurgeTimer = setInterval(async () => {
                    await purgeArchiveOlderThan(days);
                }, (hours || 24) * 60 * 60 * 1000);
            }
            return;
        }

        // Leader election enabled: attempt to acquire lock and start master duties
        const acquired = await tryAcquireMaster(lockTTL);
        if (acquired) {
            await writeLock(instanceId);
            await startMasterHeartbeat(heartbeatInterval);
            await startAsMaster();
        }

        // Start monitoring loop
        lockMonitorTimer = setInterval(async () => {
            try {
                const lock = await readLock();
                if (lock && lock.ownerId === instanceId) {
                    // we are master; ensure heartbeat running
                    await startMasterHeartbeat(heartbeatInterval);
                    if (!isMaster) await startAsMaster();
                } else {
                    // not master: check if stale
                    const age = lock ? (Date.now() - (lock.lastHeartbeat || 0)) : Infinity;
                    if (!lock || age > (lockTTL * 1000)) {
                        // try to acquire
                        const got = await tryAcquireMaster(lockTTL);
                        if (got) {
                            await writeLock(instanceId);
                            await startMasterHeartbeat(heartbeatInterval);
                            await startAsMaster();
                        }
                    } else {
                        // someone else is master
                        if (isMaster) await stopBeingMaster();
                        statusBar.text = `Copilot: monitoring (master: ${lock.ownerId.substring(0,8)})`;
                        statusBar.show();
                    }
                }
            } catch (err) {
                console.error('Error in lock monitor loop:', err);
            }
        }, (config.get<number>('copilotChatHistory.autoArchive.leaderCheckIntervalSeconds') || 10) * 1000);
    }

    // Launch monitoring loop
    monitorLockLoop();

    // Clean up timers on deactivate
    context.subscriptions.push({ dispose() {
        try { if (lockMonitorTimer) clearInterval(lockMonitorTimer); } catch(_) {}
        try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch(_) {}
        try { if (scheduledAutoArchiveTimer) clearInterval(scheduledAutoArchiveTimer); } catch(_) {}
        try { if (scheduledPurgeTimer) clearInterval(scheduledPurgeTimer); } catch(_) {}
    } });

    // Register on-demand run command
    const runAutoArchiveCommand = safeRegister('copilotChatHistory.runAutoArchiveNow', async () => {
        await runAutoArchiveNow();
        vscode.window.showInformationMessage('Auto-archive run completed. See logs for details.');
    });

    // Archive a single conversation (same as deleteConversation, but explicit alias)
    const archiveConversationCommand = safeRegister('copilotChatHistory.archiveConversation', async (session: ChatSession) => {
        try {
            const entry = await moveSessionToArchive(context, session, chatHistoryProvider);
            chatHistoryProvider.refresh();
            archiveProvider.refresh();
            const undo = 'Undo';
            const choice = await vscode.window.showInformationMessage(`Archived conversation ${session.id}`, undo);
            if (choice === undo) {
                await restoreArchivedEntries([entry]);
                chatHistoryProvider.refresh();
                archiveProvider.refresh();
                vscode.window.showInformationMessage('Archive undone. File restored.');
            }
        } catch (error) {
            if (error instanceof SessionFileError) {
                handleSessionFileError('archiveConversation', error);
                return;
            }
            console.error('Error archiving conversation:', error);
            showCentralizedError('Error archiving conversation: see logs for details.', 'archiveConversation:unexpected');
        }
    });

    // Archive all conversations in a workspace
    const archiveAllConversationsCommand = safeRegister('copilotChatHistory.archiveAllConversations', async (workspaceGroup: WorkspaceGroup) => {
        try {
            const sessions = workspaceGroup.sessions || [];
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No conversations found in workspace.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Archive all ${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} in workspace "${workspaceGroup.workspaceName}"?`,
                { modal: true },
                'Archive All'
            );

            if (confirm !== 'Archive All') {
                return;
            }

            let archived = 0;
            const errors: string[] = [];
            let cancelled = false;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Archiving conversations in ${workspaceGroup.workspaceName}...`,
                    cancellable: true
                },
                async (progress, token) => {
                    token.onCancellationRequested(() => { cancelled = true; });
                    for (const session of sessions) {
                        if (cancelled) break;
                        try {
                            await moveSessionToArchive(context, session, chatHistoryProvider);
                            archived++;
                        } catch (error) {
                            if (error instanceof SessionFileError) {
                                logSessionFileError('archiveAllConversations', error);
                                errors.push(`Failed to archive ${session.id}: ${error.message}`);
                            } else {
                                console.error('Error archiving session:', error);
                                errors.push(`Failed to archive ${session.id}: unexpected error`);
                            }
                        }

                        const increment = Math.round(100 / sessions.length * 100) / 100;
                        progress.report({ increment });
                    }
                }
            );

            chatHistoryProvider.refresh();
            archiveProvider.refresh();

            if (errors.length > 0) {
                vscode.window.showErrorMessage(`Archive completed with errors: ${archived} succeeded, ${errors.length} failed. See logs.`);
            } else {
                vscode.window.showInformationMessage(`Archived ${archived} conversation${archived !== 1 ? 's' : ''} from ${workspaceGroup.workspaceName}`);
            }
        } catch (error) {
            console.error('Error archiving workspace conversations:', error);
            showCentralizedError('Error archiving workspace conversations: see logs for details.', 'archiveAllConversations:unexpected');
        }
    });

    // Unarchive all sessions
    const unarchiveAllSessionsCommand = safeRegister('copilotChatHistory.unarchiveAllSessions', async () => {
        try {
            const archiveDir = path.join(context.globalStorageUri.fsPath, 'archive');
            if (!fs.existsSync(archiveDir)) {
                vscode.window.showInformationMessage('Archive is empty.');
                return;
            }

            const entries: ArchiveEntry[] = [];
            const allFiles = await fs.promises.readdir(archiveDir, { recursive: true }) as string[];
            
            for (const file of allFiles) {
                if (!file.endsWith('.meta.json')) continue;
                const metaPath = path.join(archiveDir, file);
                try {
                    const metaRaw = await fs.promises.readFile(metaPath, 'utf8');
                    const meta = JSON.parse(metaRaw);
                    const archivePath = metaPath.slice(0, -'.meta.json'.length);
                    entries.push({
                        originalPath: meta.originalPath,
                        archivePath: archivePath,
                        sessionId: meta.sessionId
                    });
                } catch (err) {
                    console.error('Error reading metadata:', err);
                }
            }

            if (entries.length === 0) {
                vscode.window.showInformationMessage('Archive is empty.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Restore all ${entries.length} archived conversation${entries.length !== 1 ? 's' : ''}?`,
                { modal: true },
                'Restore All'
            );

            if (confirm !== 'Restore All') {
                return;
            }

            let restored = 0;
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Restoring conversations...',
                    cancellable: false
                },
                async (progress) => {
                    for (const entry of entries) {
                        try {
                            await restoreArchivedEntries([entry]);
                            restored++;
                        } catch (error) {
                            console.error('Error restoring:', error);
                        }
                        progress.report({ increment: Math.round(100 / entries.length) });
                    }
                }
            );

            chatHistoryProvider.refresh();
            vscode.window.showInformationMessage(`Restored ${restored} conversation${restored !== 1 ? 's' : ''}.`);
        } catch (error) {
            console.error('Error unarchiving all sessions:', error);
            showCentralizedError('Error unarchiving: see logs for details.', 'unarchiveAllSessions:unexpected');
        }
    });

    // Open Auto-Archive Settings
    const openAutoArchiveSettingsCommand = safeRegister('copilotChatHistory.openAutoArchiveSettings', async () => {
        try {
            // Open the settings UI for auto-archive configuration
            await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotChatHistory.autoArchive');
        } catch (error) {
            console.error('Error opening settings:', error);
            showCentralizedError('Error opening settings: see logs for details.', 'openAutoArchiveSettings:unexpected');
        }
    });

    // Load More Conversations command - expands a workspace to show all sessions
    const loadMoreConversationsCommand = safeRegister('copilotChatHistory.loadMoreConversations', (workspaceName: string) => {
        try {
            chatHistoryProvider.toggleExpandedWorkspace(workspaceName);
        } catch (error) {
            console.error('Error loading more conversations:', error);
            showCentralizedError('Error loading more conversations: see logs for details.', 'loadMoreConversations:unexpected');
        }
    });

    // Import Chat Session - open a chat session in the Copilot chat interface with content pre-loaded
    const importChatSessionCommand = safeRegister('copilotChatHistory.importChatSession', async (session: ChatSession | { filePath: string, fileName?: string }) => {
        try {
            let chatSession: ChatSession | undefined;
            let sessionData: any;

            // Handle both ChatSession and archived session objects
            if ('id' in session) {
                // It's a ChatSession
                chatSession = session as ChatSession;
                try {
                    const sessionPath = await resolveAccessibleSessionFilePath(chatSession);
                    const rawData = await fs.promises.readFile(sessionPath, 'utf8');
                    sessionData = JSON.parse(rawData);
                } catch (error) {
                    if (error instanceof SessionFileError) {
                        handleSessionFileError('importChatSession', error);
                        return;
                    }
                    throw error;
                }
            } else {
                // It's an archived session object
                const archived = session as { filePath: string, fileName?: string };
                try {
                    const rawData = await fs.promises.readFile(archived.filePath, 'utf8');
                    sessionData = JSON.parse(rawData);
                } catch (error) {
                    console.error('Error reading archived chat session:', error);
                    showCentralizedError('Error reading archived chat session: see logs for details.', 'importChatSession:readFailed');
                    return;
                }
            }

            // Build the import text from the chat session
            const messages = sessionData.messages || [];
            let importText = '';

            if (messages.length > 0) {
                importText = 'Previous Chat History:\n\n';
                for (const msg of messages) {
                    const role = msg.role || 'unknown';
                    const content = msg.content || msg.text || '';
                    importText += `**${role.toUpperCase()}**: ${content}\n\n`;
                }
            } else {
                importText = 'Imported chat session (no previous messages)';
            }

            // Execute the Copilot Chat inline chat command with the pre-loaded context
            // This opens the Copilot chat interface with the messages as pre-loaded context
            await vscode.commands.executeCommand('github.copilot.chat.inlineChat.new', {
                prompt: 'Restored previous conversation context above.'
            });

            // Try to insert the history into the chat (alternative approach if inline command doesn't preserve context)
            const chatView = vscode.window.visibleTextEditors.find(ed => ed.document.languageId === 'copilot-chat');
            if (chatView) {
                // If we can access the chat, we could pre-populate it
                // This is a future enhancement point
                vscode.window.showInformationMessage('Chat session opened with history available. See logs for full context.');
            } else {
                vscode.window.showInformationMessage(`Chat session "${chatSession?.customTitle || 'Imported'}" opened. Copy the following context to continue:\n\n${importText}`);
            }

            console.log('Chat session imported:', importText);
        } catch (error) {
            console.error('Error importing chat session:', error);
            showCentralizedError('Error importing chat session: see logs for details.', 'importChatSession:unexpected');
        }
    });

    context.subscriptions.push(runAutoArchiveCommand, archiveConversationCommand, archiveAllConversationsCommand, unarchiveAllSessionsCommand, openAutoArchiveSettingsCommand, loadMoreConversationsCommand, importChatSessionCommand, archiveRefreshCommand);


    context.subscriptions.push(
        refreshCommand,
        openChatCommand,
        openChatJsonCommand,
        helloWorldCommand,
        searchCommand,
        clearFilterCommand,
        openWorkspaceInCurrentWindowCommand,
        openWorkspaceInNewWindowCommand,
        exportChatMarkdownCommand,
        exportWorkspaceConversationsCommand,
        exportSelectedConversationsCommand,
        deleteSelectedConversationsCommand,
        deleteConversationCommand,
        deleteWorkspaceConversationsCommand,
        chatTreeView,
        archiveTreeView
    );

    // Автоматически обновляем при активации
    chatHistoryProvider.refresh();
    
    // Показываем сообщение о том, что расширение активировано
    console.log('Copilot Chat History extension is now active!');
}

export function deactivate() {}
