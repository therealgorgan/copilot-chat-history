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

export interface ChatCommandRun {
    title?: string;
    command?: string;
    arguments?: unknown;
    result?: unknown;
    status?: string;
    output?: string;
    timestamp?: number;
}

export interface ChatToolInvocation {
    name?: string;
    toolName?: string;
    input?: unknown;
    arguments?: unknown;
    result?: unknown;
    output?: unknown;
    error?: unknown;
    status?: string;
    startTime?: number;
    endTime?: number;
    metadata?: Record<string, unknown>;
}

export interface ChatFileChange {
    path?: string;
    uri?: string;
    diff?: string;
    content?: string;
    explanation?: string;
    languageId?: string;
}

export interface ChatResponseItem {
    type?: string;
    kind?: string;
    mimeType?: string;
    languageId?: string;
    value?: string;
    title?: string;
    command?: string;
    arguments?: unknown;
    result?: unknown;
    output?: string;
    status?: string;
    commandRuns?: ChatCommandRun[];
    toolInvocations?: ChatToolInvocation[];
    fileChanges?: ChatFileChange[];
    fileEdits?: ChatFileChange[];
    files?: ChatFileChange[];
    [key: string]: unknown;
}

export interface ChatMessage {
    message?: {
        text?: string;
    };
    response?: ChatResponseItem[];
    commandRuns?: ChatCommandRun[];
    toolInvocations?: ChatToolInvocation[];
    fileChanges?: ChatFileChange[];
    timestamp?: number;
    [key: string]: unknown;
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
