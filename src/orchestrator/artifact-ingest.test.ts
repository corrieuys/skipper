import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../db/connection";
import { eventBus, type RealtimeTimelineUpdatedEvent } from "../events/bus";
import { ArtifactManager } from "./artifact-manager";
import { RealtimeSessionManager } from "./realtime-session";
import { pngBytes } from "./image-fixtures";
import type { TaskScheduler } from "../tasks/scheduler";

const TEST_DB = "test-artifact-ingest.db";

let db: Database;
let root: string;
let artifacts: ArtifactManager;
let sessions: RealtimeSessionManager;
let wakes: string[];
let revived: string[];

function seedTask(id: string, status: "draft" | "active" | "settled", needsReview = 0): string {
  db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status, needs_review) VALUES (?, 'Task', 'team-1', ?, ?)").run(id, status, needsReview);
  return id;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  root = mkdtempSync(join(tmpdir(), "skipper-ingest-"));
  artifacts = new ArtifactManager(db, { artifactsRoot: root });
  wakes = [];
  revived = [];
  // A scheduler stub: wakes are recorded instead of spawning anything, so
  // entries stay unfed and consumePendingFeed can be inspected.
  const scheduler = {
    requestWake: (taskId: string) => { wakes.push(taskId); },
    reviveTask: (taskId: string) => {
      revived.push(taskId);
      db.prepare("UPDATE tasks SET status = 'active', settled_at = NULL WHERE id = ?").run(taskId);
    },
    setNeedsReview: (taskId: string, value: boolean) => {
      db.prepare("UPDATE tasks SET needs_review = ? WHERE id = ?").run(value ? 1 : 0, taskId);
    },
  } as unknown as TaskScheduler;
  sessions = new RealtimeSessionManager(db, artifacts, null, scheduler);
});

afterEach(() => {
  sessions.dispose();
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("RealtimeSessionManager.ingestArtifactUpload", () => {
  it("adds an unfed high-priority image entry, emits timeline events, and wakes an active task", () => {
    const taskId = seedTask("t-active", "active");
    const artifact = artifacts.createFileArtifact({ taskId, name: "shot.png", kind: "upload", bytes: pngBytes(2048, 1536), description: "login page", source: "operator" });
    const events: RealtimeTimelineUpdatedEvent[] = [];
    const handler = (e: RealtimeTimelineUpdatedEvent) => { events.push(e); };
    eventBus.on("realtime:timeline_updated", handler);
    try {
      const result = sessions.ingestArtifactUpload(taskId, artifact, { caption: "login page", source: "operator" });
      expect(result.delivered).toBe("queued");
      const row = db.prepare("SELECT entry_type, content, priority, fed_to_skipper, artifact_id FROM realtime_timeline WHERE id = ?").get(result.entryId) as Record<string, unknown>;
      expect(row).toEqual({ entry_type: "image", content: "login page", priority: "high", fed_to_skipper: 0, artifact_id: artifact.id });
      expect(events).toHaveLength(1);
      expect(events[0]!.entryType).toBe("image");
      expect(wakes).toEqual([taskId]);
    } finally {
      eventBus.off("realtime:timeline_updated", handler);
    }
  });

  it("formats the INPUT_FEED line with the absolute path, dimensions, caption and the tool hint", () => {
    const taskId = seedTask("t-feed", "active");
    const image = artifacts.createFileArtifact({ taskId, name: "shot.png", kind: "upload", bytes: pngBytes(2048, 1536), description: "login page", source: "operator" });
    sessions.ingestArtifactUpload(taskId, image, { caption: "login page", source: "operator" });
    const pdf = artifacts.createFileArtifact({ taskId, name: "spec.pdf", kind: "upload", mime: "application/pdf", bytes: new Uint8Array(1234), source: "operator" });
    sessions.ingestArtifactUpload(taskId, pdf, { source: "operator" });

    const feed = sessions.consumePendingFeed(taskId);
    expect(feed).not.toBeNull();
    const imagePath = artifacts.getArtifactFilePath(image)!;
    const pdfPath = artifacts.getArtifactFilePath(pdf)!;
    expect(feed!.text).toContain("[INPUT_FEED]");
    expect(feed!.text).toMatch(/\[\d\d:\d\d:\d\d IMAGE PRIORITY:HIGH\] Operator attached an image artifact "shot.png" \(v1, 2048x1536\): /);
    expect(feed!.text).toContain(`${imagePath} - caption: "login page". View it with your file/image reading tool before you continue.`);
    expect(feed!.text).toMatch(/\[\d\d:\d\d:\d\d FILE PRIORITY:HIGH\] Operator attached a file artifact "spec.pdf" \(v1, application\/pdf, 1\.2 KB\): /);
    expect(feed!.text).toContain(`${pdfPath}. Read it with your file-reading tool before you continue.`);
    // no caption clause for the pdf
    expect(feed!.text).not.toContain(`${pdfPath} - caption`);

    feed!.commit();
    expect(sessions.hasPendingFeed(taskId)).toBe(false);
  });

  it("stores the entry unfed on a draft task without waking; the first run's feed carries it", () => {
    const taskId = seedTask("t-draft", "draft");
    const artifact = artifacts.createFileArtifact({ taskId, name: "brief.txt", kind: "upload", mime: "text/plain", bytes: new TextEncoder().encode("hello"), source: "operator" });
    const result = sessions.ingestArtifactUpload(taskId, artifact, { source: "operator" });
    expect(result.delivered).toBe("draft");
    expect(wakes).toEqual([]);
    expect(sessions.hasPendingFeed(taskId)).toBe(true);
    const feed = sessions.consumePendingFeed(taskId)!;
    expect(feed.text).toContain(artifacts.getArtifactFilePath(artifact)!);
    expect(feed.text).toContain("FILE PRIORITY:HIGH] Operator attached a file artifact \"brief.txt\" (v1, text/plain, 5 B)");
  });

  it("revives a settled task and clears an open review gate before waking", () => {
    const settled = seedTask("t-settled", "settled");
    const artifact = artifacts.createFileArtifact({ taskId: settled, name: "x.png", kind: "upload", bytes: pngBytes(1, 1), source: "operator" });
    expect(sessions.ingestArtifactUpload(settled, artifact, { source: "operator" }).delivered).toBe("queued");
    expect(revived).toEqual([settled]);
    expect(wakes).toEqual([settled]);

    const review = seedTask("t-review", "active", 1);
    const artifact2 = artifacts.createFileArtifact({ taskId: review, name: "y.png", kind: "upload", bytes: pngBytes(1, 1), source: "operator" });
    sessions.ingestArtifactUpload(review, artifact2, { source: "operator" });
    expect((db.prepare("SELECT needs_review FROM tasks WHERE id = ?").get(review) as { needs_review: number }).needs_review).toBe(0);
  });

  it("names an agent source in the feed line", () => {
    const taskId = seedTask("t-agent", "active");
    const artifact = artifacts.createFileArtifact({ taskId, name: "out.png", kind: "upload", bytes: pngBytes(3, 3), source: "agent-7" });
    sessions.ingestArtifactUpload(taskId, artifact, { source: "agent-7" });
    expect(sessions.consumePendingFeed(taskId)!.text).toContain("Agent agent-7 attached an image artifact");
  });
});

describe("RealtimeSessionManager.ingestAgentArtifact", () => {
  it("lands an already-fed normal-priority row, emits timeline_updated only, and never wakes or feeds", () => {
    const taskId = seedTask("t-agent", "active");
    const artifact = artifacts.createFileArtifact({ taskId, name: "shot.png", kind: "upload", bytes: pngBytes(20, 10), description: "after fix", source: "worker-1" });
    const timeline: RealtimeTimelineUpdatedEvent[] = [];
    const windows: unknown[] = [];
    const onTimeline = (e: RealtimeTimelineUpdatedEvent) => { timeline.push(e); };
    const onWindow = (e: unknown) => { windows.push(e); };
    eventBus.on("realtime:timeline_updated", onTimeline);
    eventBus.on("realtime:window_ready", onWindow as never);
    try {
      const { entryId } = sessions.ingestAgentArtifact(taskId, artifact, { agentId: "worker-1" });
      const row = db.prepare("SELECT entry_type, content, priority, fed_to_skipper, artifact_id FROM realtime_timeline WHERE id = ?").get(entryId) as Record<string, unknown>;
      expect(row).toEqual({ entry_type: "image", content: "after fix", priority: "normal", fed_to_skipper: 1, artifact_id: artifact.id });
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toEqual({ taskId, entryId, entryType: "image" });
      expect(windows).toHaveLength(0);
      expect(wakes).toEqual([]);
      expect(revived).toEqual([]);
      expect(sessions.hasPendingFeed(taskId)).toBe(false);
      expect(sessions.consumePendingFeed(taskId)).toBeNull();
    } finally {
      eventBus.off("realtime:timeline_updated", onTimeline);
      eventBus.off("realtime:window_ready", onWindow as never);
    }
  });

  it("is omitted from a feed that carries later operator input", () => {
    const taskId = seedTask("t-mixed", "active");
    const agentFile = artifacts.createFileArtifact({ taskId, name: "log.txt", kind: "upload", mime: "text/plain", bytes: new TextEncoder().encode("ok"), source: "worker-1" });
    sessions.ingestAgentArtifact(taskId, agentFile, { agentId: "worker-1" });
    const upload = artifacts.createFileArtifact({ taskId, name: "photo.png", kind: "upload", bytes: pngBytes(4, 4), source: "operator" });
    sessions.ingestArtifactUpload(taskId, upload, { source: "operator" });
    const feed = sessions.consumePendingFeed(taskId);
    expect(feed).not.toBeNull();
    expect(feed!.text).toContain("photo.png");
    expect(feed!.text).not.toContain("log.txt");
  });
});
