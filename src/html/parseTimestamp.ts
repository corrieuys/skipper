
export function parseTimestamp(input: string): Date {
    // SQLite datetime('now') format is UTC but lacks timezone, e.g. "2026-02-20 17:04:16" or "2026-02-20 17:04:16.819".
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(input)) {
        return new Date(input.replace(" ", "T") + "Z");
    }
    // Handle ISO-like values missing timezone as UTC for consistent server-generated timestamps.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(input)) {
        return new Date(input + "Z");
    }
    return new Date(input);
}
