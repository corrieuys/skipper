import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initializeDatabase } from "../db/connection";
import { eventBus, type ArtifactCreatedEvent } from "../events/bus";
import { ArtifactManager, MAX_FILE_ARTIFACT_BYTES, UPLOAD_SESSION_TTL_MS } from "./artifact-manager";
import { jpegBytes, pngBytes } from "./image-fixtures";
import { TaskScheduler } from "../tasks/scheduler";

const TEST_DB = "test-file-artifacts.db";

let db: Database;
let root: string;
let manager: ArtifactManager;

function seedTask(id = "task-1"): string {
  db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES (?, 'Task', 'team-1', 'active')").run(id);
  return id;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  root = mkdtempSync(join(tmpdir(), "skipper-artifacts-"));
  manager = new ArtifactManager(db, { artifactsRoot: root });
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("ArtifactManager.createFileArtifact", () => {
  it("writes the bytes to disk, records metadata + PNG dimensions, and emits artifact:created", () => {
    const taskId = seedTask();
    const events: ArtifactCreatedEvent[] = [];
    const handler = (e: ArtifactCreatedEvent) => { events.push(e); };
    eventBus.on("artifact:created", handler);
    try {
      const bytes = pngBytes(2048, 1536);
      const artifact = manager.createFileArtifact({
        taskId, name: "Screen shot.png", kind: "upload", mime: "image/png", bytes, description: "the login page", source: "operator",
      });
      expect(artifact.storage).toBe("file");
      expect(artifact.kind).toBe("upload");
      expect(artifact.name).toBe("Screen_shot.png");
      expect(artifact.mime).toBe("image/png");
      expect(artifact.width).toBe(2048);
      expect(artifact.height).toBe(1536);
      expect(artifact.bytes).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(artifact.body).toBe("the login page");
      expect(artifact.source).toBe("operator");
      expect(artifact.version).toBe(1);

      const path = manager.getArtifactFilePath(artifact)!;
      expect(path).toBe(join(root, taskId, `${artifact.id}.png`));
      expect(existsSync(path)).toBe(true);
      expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
      expect(manager.readArtifactBytes(artifact.id)!.bytes).toEqual(bytes);

      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("upload");
      expect(events[0]!.artifactId).toBe(artifact.id);
    } finally {
      eventBus.off("artifact:created", handler);
    }
  });

  it("versions a re-upload of the same filename and stores an empty caption when none is given", () => {
    const taskId = seedTask();
    const v1 = manager.createFileArtifact({ taskId, name: "photo.jpg", kind: "upload", mime: "image/jpeg", bytes: jpegBytes(640, 480), source: "operator" });
    const v2 = manager.createFileArtifact({ taskId, name: "photo.jpg", kind: "upload", mime: "image/jpeg", bytes: jpegBytes(320, 240), source: "operator" });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.width).toBe(320);
    expect(v2.body).toBe("");
    expect(v2.description).toBeNull();
    expect(manager.getArtifact(taskId, "photo.jpg", "latest")!.id).toBe(v2.id);
  });

  it("uses the sniffed mime over the declared one and takes non-image mimes as declared", () => {
    const taskId = seedTask();
    const sniffed = manager.createFileArtifact({ taskId, name: "pic", kind: "upload", mime: "application/octet-stream", bytes: pngBytes(4, 4), source: "operator" });
    expect(sniffed.mime).toBe("image/png");
    expect(manager.getArtifactFilePath(sniffed)).toBe(join(root, taskId, `${sniffed.id}.png`));

    const pdf = manager.createFileArtifact({ taskId, name: "doc.pdf", kind: "upload", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4"), source: "operator" });
    expect(pdf.mime).toBe("application/pdf");
    expect(pdf.width).toBeNull();

    const unknown = manager.createFileArtifact({ taskId, name: "blob", kind: "upload", mime: null, bytes: new Uint8Array([1, 2, 3]), source: "operator" });
    expect(unknown.mime).toBe("application/octet-stream");
    expect(manager.getArtifactFilePath(unknown)).toBe(join(root, taskId, `${unknown.id}.bin`));
  });

  it("rejects a declared image whose bytes are not a supported image, leaving no file behind", () => {
    const taskId = seedTask();
    expect(() => manager.createFileArtifact({
      taskId, name: "fake.png", kind: "upload", mime: "image/png", bytes: new TextEncoder().encode("not an image"), source: "operator",
    })).toThrow(/Not a supported image/);
    expect(existsSync(join(root, taskId))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_artifacts").get()).toEqual({ c: 0 });
  });

  it("rejects empty files and files over the 25 MB cap", () => {
    const taskId = seedTask();
    expect(() => manager.createFileArtifact({ taskId, name: "e.bin", kind: "upload", bytes: new Uint8Array(0), source: "operator" })).toThrow(/empty/);
    expect(() => manager.createFileArtifact({
      taskId, name: "big.bin", kind: "upload", bytes: new Uint8Array(MAX_FILE_ARTIFACT_BYTES + 1), source: "operator",
    })).toThrow(/too large/);
  });

  it("lists file artifacts with storage + mime + size + dimensions, and get_artifact-style reads see the file path", () => {
    const taskId = seedTask();
    manager.createArtifact({ taskId, name: "plan", kind: "plan", body: "text" });
    const file = manager.createFileArtifact({ taskId, name: "a.png", kind: "upload", bytes: pngBytes(10, 20), source: "operator" });
    const items = manager.listArtifacts({ taskId });
    const fileItem = items.find((i) => i.id === file.id)!;
    expect(fileItem.storage).toBe("file");
    expect(fileItem.mime).toBe("image/png");
    expect(fileItem.width).toBe(10);
    expect(fileItem.height).toBe(20);
    expect(fileItem.bytes).toBe(file.bytes);
    const inline = items.find((i) => i.name === "plan")!;
    expect(inline.storage).toBe("inline");
    expect(manager.readArtifactBytes(inline.id)).toBeNull();
  });
});

describe("ArtifactManager chunked uploads", () => {
  it("begin/chunk/commit assembles the file, verifies sha256 and creates the artifact", () => {
    const taskId = seedTask();
    const bytes = pngBytes(64, 32, 1000);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploadId = manager.beginUpload({ taskId, kind: "upload", name: "chunked.png", mime: "image/png", bytes: bytes.byteLength, sha256, description: "in pieces", source: "connect:phone" });
    expect(manager.appendChunk(uploadId, 0, bytes.subarray(0, 400))).toEqual({ received: 400 });
    expect(manager.appendChunk(uploadId, 1, bytes.subarray(400, 800))).toEqual({ received: 800 });
    expect(manager.appendChunk(uploadId, 2, bytes.subarray(800))).toEqual({ received: 1000 });
    const artifact = manager.commitUpload(uploadId);
    expect(artifact.storage).toBe("file");
    expect(artifact.sha256).toBe(sha256);
    expect(artifact.width).toBe(64);
    expect(artifact.body).toBe("in pieces");
    expect(artifact.source).toBe("connect:phone");
    expect(manager.readArtifactBytes(artifact.id)!.bytes).toEqual(bytes);
    // the session is gone after commit
    expect(() => manager.commitUpload(uploadId)).toThrow(/Unknown or expired/);
  });

  it("rejects out-of-order chunks, oversize declarations, checksum mismatches and incomplete commits", () => {
    const taskId = seedTask();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(() => manager.beginUpload({ taskId, kind: "upload", name: "x", bytes: MAX_FILE_ARTIFACT_BYTES + 1, sha256, source: "s" })).toThrow(/too large/);
    expect(() => manager.beginUpload({ taskId, kind: "upload", name: "x", bytes: 6, sha256: "nope", source: "s" })).toThrow(/sha256/);

    const u1 = manager.beginUpload({ taskId, kind: "upload", name: "x.bin", bytes: 6, sha256, source: "s" });
    manager.appendChunk(u1, 0, bytes.subarray(0, 3));
    expect(() => manager.appendChunk(u1, 2, bytes.subarray(3))).toThrow(/Out-of-order/);
    expect(() => manager.commitUpload(u1)).toThrow(/incomplete/);

    const u2 = manager.beginUpload({ taskId, kind: "upload", name: "x.bin", bytes: 6, sha256: "0".repeat(64), source: "s" });
    manager.appendChunk(u2, 0, bytes);
    expect(() => manager.commitUpload(u2)).toThrow(/checksum/);

    const u3 = manager.beginUpload({ taskId, kind: "upload", name: "x.bin", bytes: 6, sha256, source: "s" });
    expect(() => manager.appendChunk(u3, 0, new Uint8Array(7))).toThrow(/exceeds the declared size/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_artifacts").get()).toEqual({ c: 0 });
  });

  it("abort discards a session and idle sessions expire after the TTL", () => {
    const taskId = seedTask();
    const sha256 = createHash("sha256").update(new Uint8Array([1])).digest("hex");
    const aborted = manager.beginUpload({ taskId, kind: "upload", name: "a", bytes: 1, sha256, source: "s" });
    expect(manager.abortUpload(aborted)).toBe(true);
    expect(manager.abortUpload(aborted)).toBe(false);
    expect(() => manager.appendChunk(aborted, 0, new Uint8Array([1]))).toThrow(/Unknown or expired/);

    const realNow = Date.now;
    try {
      const start = realNow();
      Date.now = () => start;
      const stale = manager.beginUpload({ taskId, kind: "upload", name: "b", bytes: 1, sha256, source: "s" });
      Date.now = () => start + UPLOAD_SESSION_TTL_MS + 1;
      expect(() => manager.appendChunk(stale, 0, new Uint8Array([1]))).toThrow(/Unknown or expired/);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("TaskScheduler.deleteTask", () => {
  it("removes the task's artifact folder from the data dir", () => {
    const previous = process.env.SKIPPER_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "skipper-data-"));
    process.env.SKIPPER_DATA_DIR = dataDir;
    try {
      const defaultRootManager = new ArtifactManager(db);
      const scheduler = new TaskScheduler(db);
      db.prepare("INSERT OR IGNORE INTO agents (id, name, type, model) VALUES ('a1', 'A', 'claude-code', 'default')").run();
      db.prepare("INSERT INTO teams (id, name, entrypoint_agent_id) VALUES ('team-d', 'Team', 'a1')").run();
      const task = scheduler.createTask({ title: "Doomed", teamId: "team-d", workingDirectory: "" });
      const artifact = defaultRootManager.createFileArtifact({ taskId: task.id, name: "x.png", kind: "upload", bytes: pngBytes(1, 1), source: "operator" });
      const folder = join(dataDir, "artifacts", task.id);
      expect(existsSync(defaultRootManager.getArtifactFilePath(artifact)!)).toBe(true);
      expect(scheduler.deleteTask(task.id)).toBe(true);
      expect(existsSync(folder)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SKIPPER_DATA_DIR; else process.env.SKIPPER_DATA_DIR = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
