import * as fs from 'fs';
import * as path from 'path';
import type { ChatSession, ChatSessionData } from '../types';

export class SessionFileError extends Error {
    readonly context: string;
    readonly cause?: unknown;

    constructor(message: string, context: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'SessionFileError';
        this.context = context;
        if (options?.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}

export async function resolveSessionFilePath(session: ChatSession): Promise<string> {
    if (!session.filePath || !session.storageRoot) {
        throw new SessionFileError('Session is missing file path metadata.', 'sessionPath:metadataMissing');
    }

    try {
        const [realFilePath, realRoot] = await Promise.all([
            fs.promises.realpath(session.filePath),
            fs.promises.realpath(session.storageRoot)
        ]);

        const relative = path.relative(realRoot, realFilePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new SessionFileError(
                `Session file path is outside of expected directory: ${session.filePath}`,
                'sessionPath:outsideRoot'
            );
        }

        return realFilePath;
    } catch (error) {
        if (error instanceof SessionFileError) {
            throw error;
        }
        throw new SessionFileError(
            'Error resolving real paths for session file or storage root.',
            'sessionPath:resolutionFailed',
            { cause: error }
        );
    }
}

export async function resolveAccessibleSessionFilePath(
    session: ChatSession,
    accessMode: number = fs.constants.R_OK
): Promise<string> {
    const sessionFilePath = await resolveSessionFilePath(session);

    try {
        await fs.promises.access(sessionFilePath, accessMode);
        return sessionFilePath;
    } catch (error) {
        throw new SessionFileError(
            `Chat session file not found: ${sessionFilePath}`,
            'sessionPath:notFound',
            { cause: error }
        );
    }
}

export async function loadSessionData(session: ChatSession): Promise<{ filePath: string; data: ChatSessionData }> {
    const sessionFilePath = await resolveAccessibleSessionFilePath(session);

    let sessionRaw: string;
    try {
        sessionRaw = await fs.promises.readFile(sessionFilePath, 'utf8');
    } catch (error) {
        throw new SessionFileError(
            `Unable to read chat session file: ${sessionFilePath}`,
            'sessionFile:readFailed',
            { cause: error }
        );
    }

    try {
        const sessionData = JSON.parse(sessionRaw) as ChatSessionData;
        return { filePath: sessionFilePath, data: sessionData };
    } catch (error) {
        throw new SessionFileError(
            `Chat session file is invalid or corrupted: ${sessionFilePath}`,
            'sessionFile:parseFailed',
            { cause: error }
        );
    }
}
