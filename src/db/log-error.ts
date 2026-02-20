import type { Database } from "bun:sqlite";

/**
 * Inserts a structured error event into the events table.
 * Silently swallows any errors (e.g. DB closed during shutdown) to avoid
 * recursive error handling.
 */
export function logError(
  db: Database,
  eventType: string,
  context: Record<string, unknown>,
  error: unknown,
): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const payload = JSON.stringify({
      ...context,
      error_message: err.message,
      error_stack: err.stack,
    });
    const agentId = (context.agentId as string) ?? null;
    const taskId = (context.taskId as string) ?? null;
    db.prepare(
      "INSERT INTO events (type, payload, source_agent_id, task_id) VALUES (?, ?, ?, ?)",
    ).run(eventType, payload, agentId, taskId);
  } catch {
    // Best-effort: silently ignore if DB is closed or insert fails
  }
}
