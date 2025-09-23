export interface ChatSession {
    id: string;
    customTitle?: string;
    workspaceName: string;
    workspacePath?: string;
    lastModified: Date;
    filePath: string;
    messageCount: number;
    storageRoot: string;
}

export interface ChatMessage {
    message?: {
        text?: string;
    };
    response?: Array<{
        value?: string;
    }>;
    timestamp?: number;
}

export interface ChatSessionData {
    version: number;
    requesterUsername: string;
    responderUsername: string;
    requests: ChatMessage[];
    customTitle?: string;
    creationDate?: number;
    lastMessageDate?: number;
}
