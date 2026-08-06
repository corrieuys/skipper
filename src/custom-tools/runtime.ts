import type { CustomTool } from "./store";

/**
 * Context a tool body is given about the run it was called from. Read-only and
 * deliberately small: it answers "which task am I in" without handing every tool
 * the database.
 */
export interface ToolContext {
  taskId: string | null;
  agentId: string | null;
  instanceId: string;
  workingDir: string;
}

export interface ToolExecution {
  ok: boolean;
  /** Whatever the function returned, or the error message when `ok` is false. */
  output: string;
  /** `console.log` output from the body, in order. */
  logs: string[];
  durationMs: number;
  timedOut: boolean;
}

/**
 * The worker body, as a string.
 *
 * Inlined rather than a separate module for one reason: it has to survive
 * `bun build --compile`, where a `new Worker(new URL("./x.ts", import.meta.url))`
 * needs the bundler to have resolved and emitted a second entry point. A blob
 * URL over a literal has nothing to resolve, so the compiled binary behaves
 * exactly like the dev run.
 *
 * The body is compiled with `AsyncFunction`, so a tool may `await` and must
 * `return` its result. Only `args`, `ctx`, `console` and `fetch` are named
 * parameters — everything else it can see is whatever a bare Worker global scope
 * provides. This is isolation from the daemon's own state and event loop, not a
 * security sandbox: the code is the operator's own, and it can still reach the
 * network.
 */
const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { code, args, ctx } = event.data;
  const logs = [];
  const say = (...parts) => {
    logs.push(parts.map((p) => {
      if (typeof p === "string") return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    }).join(" "));
  };
  const sandboxConsole = { log: say, info: say, warn: say, error: say, debug: say };

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("args", "ctx", "console", "fetch", code);
    const result = await fn(args, ctx, sandboxConsole, fetch);
    self.postMessage({ ok: true, result: serialize(result), logs });
  } catch (err) {
    self.postMessage({ ok: false, error: describe(err), logs });
  }

  // Build the message ourselves rather than trusting err.stack: in a worker the
  // stack can come back without the message on the first line, which leaves the
  // model reading a trace with no reason in it. Frames are kept but stripped of
  // the blob: URL noise, which names nothing an operator can act on.
  function describe(err) {
    if (!err) return "Unknown error";
    const name = err.name || "Error";
    const message = err.message !== undefined ? String(err.message) : String(err);
    const head = message ? name + ": " + message : name;
    if (!err.stack) return head;
    const frames = String(err.stack)
      .split("\\n")
      .filter((line) => /^\\s+at /.test(line))
      .map((line) => line.replace(/\\(?(?:file:\\/\\/\\/)?blob:[0-9a-f-]+:/gi, "(tool:"))
      .slice(0, 5);
    return frames.length > 0 ? head + "\\n" + frames.join("\\n") : head;
  }

  function serialize(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
};
`;

/**
 * Run a tool body and return what it produced.
 *
 * The Worker is the point: a tool with an infinite loop cannot be interrupted
 * on the daemon's own thread, and hanging the orchestrator is a far worse
 * outcome than a tool call failing. On timeout the worker is terminated
 * outright, which does stop a busy loop.
 *
 * Never throws — a broken tool must come back as a failed tool result the model
 * can read and react to, not as an exception that fails the whole run.
 */
export function executeCustomTool(
  tool: Pick<CustomTool, "code" | "timeoutMs" | "name">,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const started = Date.now();

  return new Promise<ToolExecution>((resolve) => {
    let worker: Worker;
    let url: string;
    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
      worker = new Worker(url);
    } catch (err) {
      resolve({
        ok: false,
        output: `Could not start the tool runtime: ${err instanceof Error ? err.message : String(err)}`,
        logs: [],
        durationMs: Date.now() - started,
        timedOut: false,
      });
      return;
    }

    let settled = false;
    const finish = (execution: Omit<ToolExecution, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve({ ...execution, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        output: `Tool "${tool.name}" timed out after ${tool.timeoutMs}ms and was stopped.`,
        logs: [],
        timedOut: true,
      });
    }, tool.timeoutMs);
    // The daemon must not be held open by a tool's timer.
    (timer as unknown as { unref?: () => void }).unref?.();

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { ok: boolean; result?: string; error?: string; logs?: string[] };
      finish({
        ok: data.ok,
        output: data.ok ? (data.result ?? "") : (data.error ?? "Tool failed"),
        logs: data.logs ?? [],
        timedOut: false,
      });
    };

    worker.onerror = (event: ErrorEvent) => {
      finish({
        ok: false,
        output: event.message || "Tool failed to load",
        logs: [],
        timedOut: false,
      });
    };

    worker.postMessage({ code: tool.code, args, ctx });
  });
}

/** Tool result text for the model: the return value, with any logs attached. */
export function formatExecution(execution: ToolExecution): string {
  const parts: string[] = [];
  if (execution.logs.length > 0) parts.push(execution.logs.map((l) => `[log] ${l}`).join("\n"));
  parts.push(execution.ok ? (execution.output || "(no output)") : `Error: ${execution.output}`);
  return parts.join("\n");
}
