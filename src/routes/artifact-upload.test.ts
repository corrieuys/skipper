import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startServer } from "../server";
import { registerTaskRoutes } from "./tasks";
import { registerPageRoutes } from "./pages";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { ArtifactManager } from "../orchestrator/artifact-manager";
import { RealtimeSessionManager } from "../orchestrator/realtime-session";
import { pngBytes } from "../orchestrator/image-fixtures";
import type { TaskScheduler } from "../tasks/scheduler";

let server: Server;
let baseUrl: string;
let root: string;
let artifactManager: ArtifactManager;
let sessions: RealtimeSessionManager;
const wakes: string[] = [];

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO teams (id, name) VALUES ('team-1', 'Team')").run();
  db.prepare("INSERT INTO tasks (id, title, team_id, status) VALUES ('task-up', 'Upload target', 'team-1', 'active')").run();

  root = mkdtempSync(join(tmpdir(), "skipper-upload-route-"));
  artifactManager = new ArtifactManager(db, { artifactsRoot: root });
  const scheduler = { requestWake: (id: string) => { wakes.push(id); } } as unknown as TaskScheduler;
  sessions = new RealtimeSessionManager(db, artifactManager, null, scheduler);

  registerTaskRoutes({
    getRealtimeSessionManager: () => sessions,
    getArtifactManager: () => artifactManager,
  } as unknown as Parameters<typeof registerTaskRoutes>[0]);
  registerPageRoutes();

  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  sessions.dispose();
  resetDb();
  rmSync(root, { recursive: true, force: true });
});

function multipart(file: File, description?: string): FormData {
  const fd = new FormData();
  fd.append("file", file, file.name);
  if (description) fd.append("description", description);
  return fd;
}

describe("POST /api/tasks/:id/artifacts/upload", () => {
  it("creates a file artifact, puts it on the timeline and wakes the task", async () => {
    const png = pngBytes(2048, 1536);
    const res = await fetch(`${baseUrl}/api/tasks/task-up/artifacts/upload`, {
      method: "POST",
      body: multipart(new File([png], "login shot.png", { type: "image/png" }), "the login page"),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.storage).toBe("file");
    expect(body.kind).toBe("upload");
    expect(body.name).toBe("login_shot.png");
    expect(body.mime).toBe("image/png");
    expect(body.width).toBe(2048);
    expect(body.height).toBe(1536);
    expect(body.bytes).toBe(png.byteLength);
    expect(body.description).toBe("the login page");
    expect(body.file_url).toBe(`/api/artifacts/${body.id}/file`);
    expect(body.delivered).toBe("queued");
    expect("body" in body).toBe(false);

    const db = getDb();
    const entry = db.prepare("SELECT entry_type, content, fed_to_skipper, artifact_id FROM realtime_timeline WHERE task_id = 'task-up'").get() as Record<string, unknown>;
    expect(entry).toEqual({ entry_type: "image", content: "the login page", fed_to_skipper: 0, artifact_id: body.id });
    expect(wakes).toContain("task-up");
  });

  it("serves the bytes with immutable caching (inline for images, attachment otherwise) and metadata JSON", async () => {
    const png = pngBytes(8, 8);
    const created = await (await fetch(`${baseUrl}/api/tasks/task-up/artifacts/upload`, {
      method: "POST",
      body: multipart(new File([png], "tiny.png", { type: "image/png" })),
    })).json() as { id: string };

    const file = await fetch(`${baseUrl}/api/artifacts/${created.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(file.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);

    const meta = await (await fetch(`${baseUrl}/api/artifacts/${created.id}/meta`)).json() as Record<string, unknown>;
    expect(meta.id).toBe(created.id);
    expect(meta.storage).toBe("file");
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect("body" in meta).toBe(false);

    const doc = await (await fetch(`${baseUrl}/api/tasks/task-up/artifacts/upload`, {
      method: "POST",
      body: multipart(new File([new TextEncoder().encode("%PDF-1.4 x")], "spec.pdf", { type: "application/pdf" })),
    })).json() as { id: string };
    const pdf = await fetch(`${baseUrl}/api/artifacts/${doc.id}/file`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="spec.pdf"');

    expect((await fetch(`${baseUrl}/api/artifacts/nope/file`)).status).toBe(404);
  });

  it("returns 400 for a missing file, a bad image, and 404 for an unknown task", async () => {
    const empty = await fetch(`${baseUrl}/api/tasks/task-up/artifacts/upload`, { method: "POST", body: new FormData() });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain("file is required");

    const fake = await fetch(`${baseUrl}/api/tasks/task-up/artifacts/upload`, {
      method: "POST",
      body: multipart(new File([new TextEncoder().encode("nope")], "fake.png", { type: "image/png" })),
    });
    expect(fake.status).toBe(400);
    expect(((await fake.json()) as { error: string }).error).toContain("Not a supported image");

    const missing = await fetch(`${baseUrl}/api/tasks/no-such-task/artifacts/upload`, {
      method: "POST",
      body: multipart(new File([pngBytes(1, 1)], "a.png", { type: "image/png" })),
    });
    expect(missing.status).toBe(404);
  });

  it("returns the refreshed artifacts rail fragment for htmx callers", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/task-up/artifacts/upload`, {
      method: "POST",
      headers: { "HX-Request": "true" },
      body: multipart(new File([pngBytes(3, 3)], "rail.png", { type: "image/png" }), "rail"),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-sk-artifact-upload="task-up"');
    expect(html).toContain("rail.png");
    expect(html).toContain("tc-art__thumb");
    expect(html).toContain("/file");
  });

  it("JSON artifact reads by name return metadata without a body for file artifacts", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/task-up/artifacts/rail.png`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.storage).toBe("file");
    expect(body.description).toBe("rail");
    expect("body" in body).toBe(false);
    expect(body.file_url).toBe(`/api/artifacts/${body.id}/file`);
  });

  it("renders upload entries on the timeline fragment and file artifacts in the detail overlay", async () => {
    const timeline = await (await fetch(`${baseUrl}/workspace/task/task-up/timeline`)).text();
    expect(timeline).toContain("tc-entry--upload");
    expect(timeline).toContain('class="tc-upload__img"');
    expect(timeline).toContain("the login page");
    expect(timeline).toContain("spec.pdf");
    expect(timeline).toContain("Download");

    const detail = await (await fetch(`${baseUrl}/fragments/tasks/task-up/artifacts/spec.pdf`)).text();
    expect(detail).toContain("artifact-detail--file");
    expect(detail).toContain("Download spec.pdf");
    expect(detail).not.toContain("data-sk-artifact-edit");

    const imageDetail = await (await fetch(`${baseUrl}/fragments/tasks/task-up/artifacts/tiny.png`)).text();
    expect(imageDetail).toContain('class="artifact-file__img"');
    expect(imageDetail).toContain("8&times;8");
  });
});
