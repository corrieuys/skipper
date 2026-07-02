import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { ArtifactManager } from "./artifact-manager";
import { unlinkSync } from "fs";

const TEST_DB = "test-artifact-manager.db";

let db: Database;
let artifactManager: ArtifactManager;

function seedTask(database: Database, id = "task-1"): string {
  database.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
  database
    .prepare("INSERT INTO tasks (id, title, team_id, status) VALUES (?, ?, ?, 'running')")
    .run(id, "Test Task", "team-1");
  return id;
}

function seedAgent(database: Database, id = "agent-1"): string {
  database
    .prepare("INSERT INTO agents (id, name, type) VALUES (?, ?, 'claude-code')")
    .run(id, "Agent 1");
  return id;
}

beforeEach(() => {
  db = new Database(TEST_DB);
  db.exec("PRAGMA foreign_keys = ON");
  initializeDatabase(db);
  artifactManager = new ArtifactManager(db);
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
});

describe("ArtifactManager", () => {
  describe("createArtifact", () => {
    it("creates an artifact with version 1", () => {
      const taskId = seedTask(db);
      const artifact = artifactManager.createArtifact({
        taskId,
        name: "test-artifact",
        kind: "plan",
        description: "Test plan",
        body: "This is the plan body",
      });

      expect(artifact.id).toBeTruthy();
      expect(artifact.task_id).toBe(taskId);
      expect(artifact.name).toBe("test-artifact");
      expect(artifact.version).toBe(1);
      expect(artifact.kind).toBe("plan");
      expect(artifact.body).toBe("This is the plan body");
    });

    it("auto-increments version for same task+name", () => {
      const taskId = seedTask(db);
      const v1 = artifactManager.createArtifact({
        taskId,
        name: "summary",
        kind: "summary",
        body: "Version 1",
      });
      const v2 = artifactManager.createArtifact({
        taskId,
        name: "summary",
        kind: "summary",
        body: "Version 2",
      });

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v2.body).toBe("Version 2");
    });

    it("rejects invalid artifact kind", () => {
      const taskId = seedTask(db);
      expect(() => artifactManager.createArtifact({
        taskId,
        name: "bad",
        kind: "invalid" as any,
        body: "test",
      })).toThrow("Invalid artifact kind");
    });

    it("creates artifact with null description", () => {
      const taskId = seedTask(db);
      const artifact = artifactManager.createArtifact({
        taskId,
        name: "no-desc",
        kind: "other",
        body: "just a body",
      });
      expect(artifact.description).toBeNull();
    });

    it("tracks created_by_agent_id", () => {
      const taskId = seedTask(db);
      const agentId = seedAgent(db);
      const artifact = artifactManager.createArtifact({
        taskId,
        name: "agent-output",
        kind: "other",
        body: "output",
        createdByAgentId: agentId,
      });

      expect(artifact.created_by_agent_id).toBe(agentId);
    });
  });

  describe("getArtifact", () => {
    it("returns latest version by default", () => {
      const taskId = seedTask(db);
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v2" });
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v3" });

      const latest = artifactManager.getArtifact(taskId, "doc");
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(3);
      expect(latest!.body).toBe("v3");
    });

    it("returns specific version", () => {
      const taskId = seedTask(db);
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v2" });

      const v1 = artifactManager.getArtifact(taskId, "doc", 1);
      expect(v1).not.toBeNull();
      expect(v1!.version).toBe(1);
      expect(v1!.body).toBe("v1");
    });

    it("returns null for non-existent artifact", () => {
      const taskId = seedTask(db);
      const result = artifactManager.getArtifact(taskId, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("listArtifacts", () => {
    it("lists artifacts for a task", () => {
      const taskId = seedTask(db);
      artifactManager.createArtifact({ taskId, name: "plan", kind: "plan", body: "p" });
      artifactManager.createArtifact({ taskId, name: "summary", kind: "summary", body: "s" });

      const items = artifactManager.listArtifacts({ taskId });
      expect(items.length).toBe(2);
    });

    it("filters by kind", () => {
      const taskId = seedTask(db);
      artifactManager.createArtifact({ taskId, name: "plan", kind: "plan", body: "p" });
      artifactManager.createArtifact({ taskId, name: "summary", kind: "summary", body: "s" });

      const plans = artifactManager.listArtifacts({ taskId, kind: "plan" });
      expect(plans.length).toBe(1);
      expect(plans[0].name).toBe("plan");
    });

    it("filters by name prefix", () => {
      const taskId = seedTask(db);
      artifactManager.createArtifact({ taskId, name: "analysis-1", kind: "other", body: "a" });
      artifactManager.createArtifact({ taskId, name: "analysis-2", kind: "other", body: "b" });
      artifactManager.createArtifact({ taskId, name: "summary", kind: "summary", body: "s" });

      const items = artifactManager.listArtifacts({ taskId, namePrefix: "analysis" });
      expect(items.length).toBe(2);
    });

    it("respects limit", () => {
      const taskId = seedTask(db);
      for (let i = 0; i < 5; i++) {
        artifactManager.createArtifact({ taskId, name: `item-${i}`, kind: "other", body: `${i}` });
      }

      const items = artifactManager.listArtifacts({ taskId, limit: 2 });
      expect(items.length).toBe(2);
    });
  });

  describe("listVersions", () => {
    it("returns all versions of an artifact", () => {
      const taskId = seedTask(db);
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v2" });
      artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v3" });

      const versions = artifactManager.listVersions(taskId, "doc");
      expect(versions.length).toBe(3);
      expect(versions[0].version).toBe(3);
      expect(versions[2].version).toBe(1);
    });
  });

  describe("publish", () => {
    it("publishArtifact generates a key and sets published_at", () => {
      const taskId = seedTask(db);
      const created = artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      expect(created.publish_key).toBeNull();
      expect(created.published_at).toBeNull();

      const published = artifactManager.publishArtifact(created.id);
      expect(published?.publish_key).toBeTruthy();
      expect(published?.published_at).toBeTruthy();
    });

    it("keeps the same key across unpublish and republish", () => {
      const taskId = seedTask(db);
      const created = artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      const first = artifactManager.publishArtifact(created.id);

      const unpublished = artifactManager.unpublishArtifact(created.id);
      expect(unpublished?.published_at).toBeNull();
      expect(unpublished?.publish_key).toBe(first!.publish_key!);

      const republished = artifactManager.publishArtifact(created.id);
      expect(republished?.publish_key).toBe(first!.publish_key!);
      expect(republished?.published_at).toBeTruthy();
    });

    it("publish is scoped to one version", () => {
      const taskId = seedTask(db);
      const v1 = artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      const v2 = artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v2" });

      artifactManager.publishArtifact(v1.id);
      expect(artifactManager.getArtifactById(v1.id)?.published_at).toBeTruthy();
      expect(artifactManager.getArtifactById(v2.id)?.published_at).toBeNull();
    });

    it("publishArtifact returns null for unknown id", () => {
      expect(artifactManager.publishArtifact("nope")).toBeNull();
      expect(artifactManager.unpublishArtifact("nope")).toBeNull();
    });

    it("getPublishedArtifact returns the artifact only for the correct key", () => {
      const taskId = seedTask(db);
      const created = artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "public body" });
      const published = artifactManager.publishArtifact(created.id)!;

      const fetched = artifactManager.getPublishedArtifact(created.id, published.publish_key!);
      expect(fetched?.body).toBe("public body");

      expect(artifactManager.getPublishedArtifact(created.id, "wrong-key")).toBeNull();
      expect(artifactManager.getPublishedArtifact(created.id, "")).toBeNull();
      expect(artifactManager.getPublishedArtifact("unknown-id", published.publish_key!)).toBeNull();
    });

    it("getPublishedArtifact returns null after unpublish even with the right key", () => {
      const taskId = seedTask(db);
      const created = artifactManager.createArtifact({ taskId, name: "doc", kind: "plan", body: "v1" });
      const published = artifactManager.publishArtifact(created.id)!;
      artifactManager.unpublishArtifact(created.id);

      expect(artifactManager.getPublishedArtifact(created.id, published.publish_key!)).toBeNull();
    });
  });

});
