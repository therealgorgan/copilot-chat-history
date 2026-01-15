import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeFileName } from './markdown/chatMarkdown';

export interface ArchiveGroup {
    workspaceName: string;
    folderPath: string;
}

export interface ArchivedSession {
    filePath: string;
    fileName: string;
    sessionId?: string;
    title?: string;
    workspaceName?: string;
}

export interface AutoArchiveStatus {
    type: 'autoArchiveStatus';
}

export class ArchiveProvider implements vscode.TreeDataProvider<ArchiveGroup | ArchivedSession | AutoArchiveStatus> {
    private _onDidChangeTreeData: vscode.EventEmitter<ArchiveGroup | ArchivedSession | AutoArchiveStatus | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<ArchiveGroup | ArchivedSession | AutoArchiveStatus | undefined | null | void> = this._onDidChangeTreeData.event;
    private context: vscode.ExtensionContext;
    private lastAutoArchiveTime: number | undefined;
    private autoArchiveEnabled: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.updateAutoArchiveStatus();
    }

    private updateAutoArchiveStatus(): void {
        const config = vscode.workspace.getConfiguration();
        this.autoArchiveEnabled = config.get<boolean>('copilotChatHistory.autoArchive.enabled') ?? false;
        this.lastAutoArchiveTime = this.context.globalState.get<number>('lastAutoArchiveTime');
    }

    setLastAutoArchiveTime(timestamp: number): void {
        this.lastAutoArchiveTime = timestamp;
        this.context.globalState.update('lastAutoArchiveTime', timestamp);
    }

    refresh(): void {
        this.updateAutoArchiveStatus();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ArchiveGroup | ArchivedSession | AutoArchiveStatus): vscode.TreeItem {
        if ('type' in element && element.type === 'autoArchiveStatus') {
            const config = vscode.workspace.getConfiguration();
            this.autoArchiveEnabled = config.get<boolean>('copilotChatHistory.autoArchive.enabled') ?? false;
            
            let label: string;
            if (this.autoArchiveEnabled) {
                const lastTime = this.lastAutoArchiveTime;
                if (lastTime) {
                    const date = new Date(lastTime);
                    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
                    label = `Auto-Archive: Enabled - Last Updated: ${dateStr} at ${timeStr}`;
                } else {
                    label = 'Auto-Archive: Enabled - Never run';
                }
            } else {
                label = 'Auto-Archive: Disabled';
            }
            
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.id = 'autoArchiveStatus';
            item.contextValue = 'autoArchiveStatus';
            item.iconPath = this.autoArchiveEnabled ? new vscode.ThemeIcon('pass') : new vscode.ThemeIcon('stop');
            
            // Add buttons to control auto-archive
            (item as any).buttons = [
                {
                    iconPath: new vscode.ThemeIcon('settings'),
                    tooltip: 'Auto-Archive Settings',
                    command: {
                        command: 'copilotChatHistory.openAutoArchiveSettings',
                        title: 'Auto-Archive Settings',
                        arguments: []
                    }
                },
                {
                    iconPath: new vscode.ThemeIcon('sync'),
                    tooltip: 'Run Auto-Archive Now',
                    command: {
                        command: 'copilotChatHistory.runAutoArchiveNow',
                        title: 'Run Auto-Archive Now',
                        arguments: []
                    }
                }
            ];
            
            return item;
        }
        
        if ('folderPath' in element) {
            const count = this.countArchivedFiles(element.folderPath);
            const label = `${element.workspaceName} (${count})`;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
            item.contextValue = 'archiveGroup';
            item.id = `archive-${element.workspaceName}`;
            
            // Add action buttons for archive group
            (item as any).buttons = [
                {
                    iconPath: new vscode.ThemeIcon('debug-restart'),
                    tooltip: 'Unarchive All',
                    command: {
                        command: 'copilotChatHistory.unarchiveAllSessions',
                        title: 'Unarchive All',
                        arguments: []
                    }
                },
                {
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: 'Empty Archive',
                    command: {
                        command: 'copilotChatHistory.emptyArchive',
                        title: 'Empty Archive',
                        arguments: []
                    }
                }
            ];
            
            return item;
        }

        // At this point, element is ArchivedSession
        const archivedSession = element as ArchivedSession;
        const item = new vscode.TreeItem(archivedSession.title || archivedSession.fileName, vscode.TreeItemCollapsibleState.None);
        item.description = archivedSession.sessionId ? archivedSession.sessionId : undefined;
        item.tooltip = archivedSession.filePath;
        item.contextValue = 'archivedSession';
        
        // Add action buttons for archived session - ordered: Unarchive, Import, Delete
        (item as any).buttons = [
            {
                iconPath: new vscode.ThemeIcon('undo'),
                tooltip: 'Restore Archived Conversation',
                command: {
                    command: 'copilotChatHistory.restoreArchivedSession',
                    title: 'Restore',
                    arguments: [element]
                }
            },
            {
                iconPath: new vscode.ThemeIcon('debug-disconnect'),
                tooltip: 'Import Chat (Pre-load in Copilot)',
                command: {
                    command: 'copilotChatHistory.importChatSession',
                    title: 'Import Chat',
                    arguments: [element]
                }
            },
            {
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: 'Delete Permanently',
                command: {
                    command: 'copilotChatHistory.deleteArchivedSession',
                    title: 'Delete',
                    arguments: [element]
                }
            }
        ];
        
        return item;
    }

    async getChildren(element?: ArchiveGroup | ArchivedSession | AutoArchiveStatus): Promise<(ArchiveGroup | ArchivedSession | AutoArchiveStatus)[]> {
        // If no element, return the auto-archive status and archive groups
        if (!element) {
            const archiveRoot = path.join(this.context.globalStorageUri.fsPath, 'archive');
            const statusElement: AutoArchiveStatus = { type: 'autoArchiveStatus' };
            const items: (ArchiveGroup | AutoArchiveStatus)[] = [statusElement];
            
            try {
                if (!fs.existsSync(archiveRoot)) {
                    return items;
                }

                const dirs = fs.readdirSync(archiveRoot, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => ({ workspaceName: d.name, folderPath: path.join(archiveRoot, d.name) } as ArchiveGroup));

                items.push(...dirs.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName)));
                return items;
            } catch (err) {
                console.error('Error reading archive root:', err);
                return items;
            }
        } else if ('type' in element && element.type === 'autoArchiveStatus') {
            // No children for status element
            return [];
        } else if ('folderPath' in element) {
            // list archived files in this workspace folder
            try {
                if (!fs.existsSync(element.folderPath)) return [];
                const files = fs.readdirSync(element.folderPath, { withFileTypes: true })
                    .filter(f => f.isFile() && f.name.endsWith('.json'))
                    .map(f => {
                        const filePath = path.join(element.folderPath, f.name);
                        let title: string | undefined;
                        let sessionId: string | undefined;
                        try {
                            const raw = fs.readFileSync(filePath, 'utf8');
                            const data = JSON.parse(raw);
                            sessionId = path.basename(f.name, '.json');
                            title = (data.customTitle || (data.requests && data.requests[0] && data.requests[0].message && data.requests[0].message.text) || '').toString().replace(/\n/g, ' ').substring(0, 80);
                        } catch (err) {
                            // ignore
                        }
                        return { filePath, fileName: f.name, sessionId, title, workspaceName: element.workspaceName } as ArchivedSession;
                    });
                return files.sort((a, b) => (b.fileName || '').localeCompare(a.fileName));
            } catch (err) {
                console.error('Error reading archive folder:', err);
                return [];
            }
        }

        return [];
    }

    private countArchivedFiles(folderPath: string): number {
        try {
            if (!fs.existsSync(folderPath)) return 0;
            return fs.readdirSync(folderPath).filter(f => f.endsWith('.json')).length;
        } catch (err) {
            return 0;
        }
    }
}
