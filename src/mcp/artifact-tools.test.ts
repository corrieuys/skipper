import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../db/connection";
import { registerDaemonTools, type DaemonDeps } from "./tools";
import type { AgentIdentity } from "./auth";
import { GlobalStoreManager } from "../global-store/manager";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { pngBytes } from "../orchestrator/image-fixtures";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";

const TEST_DB = "test-mcp-artifact-tools.db";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>> }>;

let db: Database;
let root: string;
let artifactManager: ArtifactManager;
let sessions: RealtimeSessionManager;
let handlers: Map<string, ToolHandler>;
let identity: AgentIdentity | null;

function makeFakeServer() {
  handlers = new Map();
  return {
    tool: (name: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as ToolHandler;
      handlers.set(name, handler);
    },
  };
}

function textPayload(result: { content: Array<Record<string, unknown>> }): Record<string, unknown> {
  const text = result.content.find((c) => c.type === "text") as { text: string };
  return JSON.parse(text.text) as Record<string, unknown>;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  root = mkdtempSync(join(tmpdir(), "skipper-mcp-art-"));
  artifactManager = new ArtifactManager(db, { artifactsRoot: root });
  sessions = new RealtimeSessionManager(db, artifactManager, null, null);
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-1', 'T', 'team-1', 'active')").run();
  db.prepare("INSERT INTO agents (id, name, type, model) VALUES ('cli-agent', 'CLI', 'claude-code', 'default')").run();
  db.prepare("INSERT INTO agent_types (name, command, args, available_models, env_vars) VALUES ('custom:vision', '', '[]', '[]', '{}')").run();
  db.prepare("INSERT INTO agents (id, name, type, model) VALUES ('custom-agent', 'Custom', 'custom:vision', 'default')").run();

  const deps: DaemonDeps = {
    db,
    agentManager: {} as DaemonDeps["agentManager"],
    delegationManager: {} as DaemonDeps["delegationManager"],
    phaseManager: {} as DaemonDeps["phaseManager"],
    taskScheduler: {} as DaemonDeps["taskScheduler"],
    escalationManager: {} as DaemonDeps["escalationManager"],
    artifactManager,
    globalStoreManager: new GlobalStoreManager(db),
    realtimeSessionManager: sessions,
  };
  identity = { type: "internal", runtimeId: "rt-1", templateAgentId: "cli-agent", taskId: "task-1" };
  registerDaemonTools(makeFakeServer() as any, deps, () => identity);
});

afterEach(() => {
  sessions.dispose();
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("MCP artifact tools with file artifacts", () => {
  it("get_artifact returns metadata + path (never bytes) for a file artifact, and the body for inline ones", async () => {
    const file = artifactManager.createFileArtifact({ taskId: "task-1", name: "shot.png", kind: "upload", bytes: pngBytes(20, 10), description: "the page", source: "operator" });
    artifactManager.createArtifact({ taskId: "task-1", name: "plan", kind: "plan", body: "# plan" });

    const fileResult = await handlers.get("get_artifact")!({ name: "shot.png" });
    const payload = textPayload(fileResult);
    expect(payload.storage).toBe("file");
    expect(payload.kind).toBe("upload");
    expect(payload.name).toBe("shot.png");
    expect(payload.version).toBe(1);
    expect(payload.mime).toBe("image/png");
    expect(payload.bytes).toBe(file.bytes);
    expect(payload.width).toBe(20);
    expect(payload.height).toBe(10);
    expect(payload.sha256).toBe(file.sha256);
    expect(payload.path).toBe(artifactManager.getArtifactFilePath(file));
    expect(payload.description).toBe("the page");
    expect(String(payload.note)).toContain("Binary artifact");
    expect("body" in payload).toBe(false);
    // a CLI agent reads the path itself: no inline image block
    expect(fileResult.content.some((c) => c.type === "image")).toBe(false);

    const inline = textPayload(await handlers.get("get_artifact")!({ name: "plan" }));
    expect(inline.body).toBe("# plan");
    expect(inline.kind).toBe("plan");
  });

  it("get_artifact adds an inline image block for a custom (in-process) agent", async () => {
    artifactManager.createFileArtifact({ taskId: "task-1", name: "shot.png", kind: "upload", bytes: pngBytes(2, 2), source: "operator" });
    identity = { type: "internal", runtimeId: "rt-2", templateAgentId: "custom-agent", taskId: "task-1" };
    const result = await handlers.get("get_artifact")!({ name: "shot.png" });
    const image = result.content.find((c) => c.type === "image") as { data: string; mimeType: string } | undefined;
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe("image/png");
    expect(Buffer.from(image!.data, "base64")).toEqual(Buffer.from(pngBytes(2, 2)));
    expect(textPayload(result).storage).toBe("file");
  });

  it("list_artifacts rows carry storage, mime, bytes, width and height", async () => {
    artifactManager.createFileArtifact({ taskId: "task-1", name: "a.png", kind: "upload", bytes: pngBytes(5, 6), source: "operator" });
    artifactManager.createArtifact({ taskId: "task-1", name: "notes", kind: "other", body: "x" });
    const result = await handlers.get("list_artifacts")!({});
    const items = JSON.parse((result.content[0] as { text: string }).text) as Array<Record<string, unknown>>;
    const file = items.find((i) => i.name === "a.png")!;
    expect(file.storage).toBe("file");
    expect(file.kind).toBe("upload");
    expect(file.mime).toBe("image/png");
    expect(file.width).toBe(5);
    expect(file.height).toBe(6);
    expect(typeof file.bytes).toBe("number");
    const inline = items.find((i) => i.name === "notes")!;
    expect(inline.storage).toBe("inline");
    expect(inline.mime).toBeNull();
  });
});

describe("create_file_artifact", () => {
  function writeTemp(name: string, bytes: Uint8Array | string): string {
    const dir = join(root, "agent-out");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  it("copies the file into the store, sniffs image dimensions, attributes the agent, and lands a fed timeline row", async () => {
    const src = writeTemp("screen.png", pngBytes(640, 480));
    const result = await handlers.get("create_file_artifact")!({ name: "login-page.png", path: src, description: "login page after fix" });
    const payload = textPayload(result);
    expect(payload.storage).toBe("file");
    expect(payload.name).toBe("login-page.png");
    expect(payload.version).toBe(1);
    expect(payload.mime).toBe("image/png");
    expect(payload.width).toBe(640);
    expect(payload.height).toBe(480);
    expect(payload.bytes).toBe(pngBytes(640, 480).byteLength);
    expect(typeof payload.sha256).toBe("string");
    expect(typeof payload.id).toBe("string");
    expect(payload.description).toBe("login page after fix");
    expect(String(payload.path).startsWith(root)).toBe(true);
    expect(payload.path).not.toBe(src);

    const artifact = artifactManager.getArtifactById(String(payload.id))!;
    expect(artifact.source).toBe("cli-agent");
    expect(artifact.kind).toBe("upload");
    const stored = artifactManager.readArtifactBytes(artifact.id)!;
    expect(Buffer.from(stored.bytes)).toEqual(Buffer.from(pngBytes(640, 480)));

    const row = db.prepare("SELECT entry_type, content, priority, fed_to_skipper FROM realtime_timeline WHERE artifact_id = ?").get(artifact.id) as Record<string, unknown>;
    expect(row).toEqual({ entry_type: "image", content: "login page after fix", priority: "normal", fed_to_skipper: 1 });
    expect(sessions.consumePendingFeed("task-1")).toBeNull();
    // the task itself is untouched
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string };
    expect(task.status).toBe("active");
  });

  it("derives the mime from the extension for non-images and versions a re-used name", async () => {
    const src = writeTemp("report.pdf", "%PDF-1.4 fake");
    const first = textPayload(await handlers.get("create_file_artifact")!({ name: "report.pdf", path: src }));
    expect(first.mime).toBe("application/pdf");
    expect(first.version).toBe(1);
    const second = textPayload(await handlers.get("create_file_artifact")!({ name: "report.pdf", path: src }));
    expect(second.version).toBe(2);
    const row = db.prepare("SELECT entry_type, content FROM realtime_timeline WHERE artifact_id = ?").get(String(first.id)) as Record<string, unknown>;
    expect(row).toEqual({ entry_type: "file", content: "report.pdf" });

    const unknown = textPayload(await handlers.get("create_file_artifact")!({ name: "blob.xyz", path: writeTemp("blob.xyz", "??") }));
    expect(unknown.mime).toBe("application/octet-stream");
  });

  it("rejects a relative path, a missing file, a directory, and a file over the cap", async () => {
    const errText = async (args: Record<string, unknown>) => {
      const r = await handlers.get("create_file_artifact")!(args);
      return String((r.content[0] as { text: string }).text);
    };
    expect(await errText({ name: "a.png", path: "relative/a.png" })).toContain("must be absolute");
    expect(await errText({ name: "a.png", path: join(root, "nope.png") })).toContain("File not found");
    expect(await errText({ name: "a.png", path: root })).toContain("is a directory");
    const big = writeTemp("big.bin", new Uint8Array(25 * 1024 * 1024 + 1));
    expect(await errText({ name: "big.bin", path: big })).toContain("too large");
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_artifacts").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM realtime_timeline").get()).toEqual({ c: 0 });
  });
});
