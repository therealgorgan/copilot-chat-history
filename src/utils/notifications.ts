import * as vscode from 'vscode';

const shownErrorContexts = new Map<string, ReturnType<typeof setTimeout>>();

export function showCentralizedError(message: string, context: string, resetDelayMs: number = 5000): void {
    if (shownErrorContexts.has(context)) {
        return;
    }

    vscode.window.showErrorMessage(message);

    const timeoutHandle = setTimeout(() => {
        shownErrorContexts.delete(context);
    }, resetDelayMs);

    shownErrorContexts.set(context, timeoutHandle);
}

export function clearErrorContext(context: string): void {
    const timeoutHandle = shownErrorContexts.get(context);
    if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        shownErrorContexts.delete(context);
    }
}

export function clearAllErrorContexts(): void {
    for (const [context, timeoutHandle] of shownErrorContexts.entries()) {
        clearTimeout(timeoutHandle);
        shownErrorContexts.delete(context);
    }
}
