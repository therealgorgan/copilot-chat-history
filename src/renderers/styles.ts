import * as fs from 'fs';
import * as path from 'path';

let cachedStyles: string | undefined;

export function getChatStyles(): string {
    if (cachedStyles === undefined) {
        const stylesPath = path.resolve(__dirname, '..', '..', 'resources', 'chatStyles.css');
        try {
            cachedStyles = fs.readFileSync(stylesPath, 'utf8');
        } catch (error) {
            console.error('Failed to load chat styles from', stylesPath, error);
            cachedStyles = '';
        }
    }

    return cachedStyles ?? '';
}
