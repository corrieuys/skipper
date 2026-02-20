import type { Database } from "bun:sqlite";

/**
 * Structured error logging utility.
 * Logs errors to the `error_log` table for debugging and auditing.
 * Falls back to console.error if DB write fails.
 */
export function logError(
  db: Database,
  category: string,
  context: Record<string, unknown>,
  error?: unknown,
): void {
  const message = error instanceof Error ? error.message : error ? String(error) : "Unknown error";
  const stack = error instanceof Error ? error.stack ?? null : null;

  try {
    db.prepare(
      `INSERT INTO error_log (category, message, context, stack, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(category, message, JSON.stringify(context), stack);
  } catch {
    // DB write failed — fall back to console
    console.error(`[${category}]`, message, context);
  }
}
