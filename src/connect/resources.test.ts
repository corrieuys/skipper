import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { setStringSetting, SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL } from "../config/app-settings";
import { handleResourceRequest, type ResourceDeps } from "./resources";
import { getPublicArtifactUrl, gidFromConnectKey } from "./public-links";

// Unsigned JWT-shaped token; only the payload's gid claim matters client-side.
function fakeConnectKey(gid: string): string {
  const payload = Buffer.from(JSON.stringify({ gid, jti: "test", kind: "connect" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

let artifactManager: ArtifactManager;
let deps: ResourceDeps;

function seedArtifact(body = "artifact body"): { taskId: string; artifactId: string } {
  const db = getDb();
  db.prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team-1", "Test Team");
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES (?, ?, ?, 'running')").run("task-1", "Test Task", "team-1");
  const artifact = artifactManager.createArtifact({ taskId: "task-1", name: "doc", kind: "plan", body });
  return { taskId: "task-1", artifactId: artifact.id };
}

beforeEach(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  artifactManager = new ArtifactManager(db);
  // Only the artifacts resource is exercised here; the other managers are not touched.
  deps = { artifactManager } as unknown as ResourceDeps;
});

afterEach(() => {
  resetDb();
});

describe("connect artifacts publish actions", () => {
  it("publish generates a public URL when connect is configured", async () => {
    const db = getDb();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid-123"));
    setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "wss://connect.example.com");
    const { artifactId } = seedArtifact();

    const result = await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { publishedAt: string; publicUrl: string } }).data;
    expect(data.publishedAt).toBeTruthy();
    expect(data.publicUrl).toStartWith(`https://connect.example.com/p/guid-123/${artifactId}?key=`);
  });

  it("publish resolves by taskId+name and returns null publicUrl without a connect key", async () => {
    const { taskId } = seedArtifact();

    const result = await handleResourceRequest("artifacts", "publish", { taskId, name: "doc" }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { publishedAt: string; publicUrl: string | null } }).data;
    expect(data.publishedAt).toBeTruthy();
    expect(data.publicUrl).toBeNull();
  });

  it("unpublish clears publishedAt", async () => {
    const { artifactId } = seedArtifact();
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);

    const result = await handleResourceRequest("artifacts", "unpublish", { id: artifactId }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { publishedAt: string | null; publicUrl: string | null } }).data;
    expect(data.publishedAt).toBeNull();
    expect(data.publicUrl).toBeNull();
  });

  it("read-published returns the body for a valid key", async () => {
    const { artifactId } = seedArtifact("<h1>hello</h1>");
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const key = artifactManager.getArtifactById(artifactId)!.publish_key!;

    const result = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key }, deps);
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: { body: string; contentType: string } }).data;
    expect(data.body).toBe("<h1>hello</h1>");
    expect(data.contentType).toBe("text/html; charset=utf-8");
  });

  it("read-published labels non-HTML bodies as plain text", async () => {
    const { artifactId } = seedArtifact("# markdown heading");
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const key = artifactManager.getArtifactById(artifactId)!.publish_key!;

    const result = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key }, deps);
    expect(result.ok).toBe(true);
    expect((result as { ok: true; data: { contentType: string } }).data.contentType).toBe("text/plain; charset=utf-8");
  });

  it("read-published returns one opaque error for wrong key, unknown id, and unpublished", async () => {
    const { artifactId } = seedArtifact();
    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const key = artifactManager.getArtifactById(artifactId)!.publish_key!;

    const wrongKey = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key: "wrong" }, deps);
    const unknownId = await handleResourceRequest("artifacts", "read-published", { id: "nope", key }, deps);
    await handleResourceRequest("artifacts", "unpublish", { id: artifactId }, deps);
    const unpublished = await handleResourceRequest("artifacts", "read-published", { id: artifactId, key }, deps);

    for (const result of [wrongKey, unknownId, unpublished]) {
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toBe("Not found or not published");
    }
  });

  it("read on an artifact includes publish state", async () => {
    const { artifactId } = seedArtifact();
    const before = await handleResourceRequest("artifacts", "read", { id: artifactId }, deps);
    expect((before as { ok: true; data: { publishedAt: string | null } }).data.publishedAt).toBeNull();

    await handleResourceRequest("artifacts", "publish", { id: artifactId }, deps);
    const after = await handleResourceRequest("artifacts", "read", { id: artifactId }, deps);
    const data = (after as { ok: true; data: { publishedAt: string; publicUrl: string | null } }).data;
    expect(data.publishedAt).toBeTruthy();
  });
});

describe("getPublicArtifactUrl", () => {
  it("encodes the key and converts ws scheme to http", () => {
    const db = getDb();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid 1"));
    setStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "ws://localhost:8080/");

    const url = getPublicArtifactUrl(db, { id: "art-1", publish_key: "k/1" });
    expect(url).toBe("http://localhost:8080/p/guid%201/art-1?key=k%2F1");
  });

  it("returns null without a connect key or without a publish key", () => {
    const db = getDb();
    expect(getPublicArtifactUrl(db, { id: "art-1", publish_key: "k" })).toBeNull();
    setStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, fakeConnectKey("guid-123"));
    expect(getPublicArtifactUrl(db, { id: "art-1", publish_key: null })).toBeNull();
  });
});

describe("gidFromConnectKey", () => {
  it("reads the gid claim from a JWT-shaped key", () => {
    expect(gidFromConnectKey(fakeConnectKey("abc-123"))).toBe("abc-123");
  });

  it("returns null for malformed keys", () => {
    expect(gidFromConnectKey("")).toBeNull();
    expect(gidFromConnectKey("not-a-jwt")).toBeNull();
    expect(gidFromConnectKey("a.%%%.c")).toBeNull();
    const noGid = `x.${Buffer.from(JSON.stringify({ kind: "connect" })).toString("base64url")}.y`;
    expect(gidFromConnectKey(noGid)).toBeNull();
  });
});
