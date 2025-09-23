export function stableSerialize(value: unknown): string | undefined {
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
                return Object.keys(nested as Record<string, unknown>)
                    .sort()
                    .reduce<Record<string, unknown>>((acc, key) => {
                        acc[key] = (nested as Record<string, unknown>)[key];
                        return acc;
                    }, {});
            }
            return nested;
        });
    } catch {
        return undefined;
    }
}
