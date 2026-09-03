import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";
import { looksLikeHtml } from "../html/atoms/sniff-html";
import { validateArtifactHtml } from "./html-validator";
import { detectImage } from "./image-meta";
import { fileExtensionFor, getArtifactsRoot, sanitizeArtifactFileName, taskArtifactDir } from "./artifact-files";

export interface TaskArtifact {
  id: string;
  task_id: string;
  name: string;
  version: number;
  kind: ArtifactKind;
  description: string | null;
  body: string;
  format: ArtifactFormat | null;
  created_by_agent_id: string | null;
  created_at: string;
  publish_key: string | null;
  published_at: string | null;
  /** 'inline' = body is the content; 'file' = bytes on disk, body is the caption. */
  storage: ArtifactStorage;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  /** 'operator', 'connect:<clientId>', or the uploading agent's id. File artifacts only. */
  source: string | null;
}

export type ArtifactKind = "transcript" | "summary" | "plan" | "other" | "upload";
export type ArtifactFormat = "html" | "markdown";
export type ArtifactStorage = "inline" | "file";

const VALID_KINDS = new Set<string>(["transcript", "summary", "plan", "other"]);
const VALID_FORMATS = new Set<string>(["html", "markdown"]);

/** Hard cap for a single file artifact. */
export const MAX_FILE_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** Chunked upload sessions expire after this much idle time. */
export const UPLOAD_SESSION_TTL_MS = 2 * 60_000;

export interface ArtifactListItem {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  storage: ArtifactStorage;
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

export interface CreateFileArtifactInput {
  taskId: string;
  /** Original filename; sanitised and used as the versioning key. */
  name: string;
  kind: "upload";
  /** Declared mime. `image/*` is verified by magic bytes; other types are taken as declared. */
  mime?: string | null;
  bytes: Uint8Array;
  /** Optional caption; stored as the artifact body (empty string when absent). */
  description?: string;
  /** 'operator', 'connect:<clientId>', or an agent id. */
  source: string;
  width?: number;
  height?: number;
}

export interface BeginUploadInput {
  taskId: string;
  kind: "upload";
  name: string;
  mime?: string | null;
  bytes: number;
  sha256: string;
  description?: string;
  source: string;
}

interface UploadSession {
  input: BeginUploadInput;
  chunks: Uint8Array[];
  received: number;
  nextIndex: number;
  expiresAt: number;
}

/** Normalise a declared mime to a safe `type/subtype` token, or null. */
function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const token = mime.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(token) ? token : null;
}

export interface CreateArtifactInput {
  taskId: string;
  name: string;
  kind: ArtifactKind;
  description?: string;
  body: string;
  /**
   * Body format. Agent-facing MCP tools require this explicitly; non-agent
   * paths (REST data API, UI in-place edit) may omit it, in which case it is
   * inferred from the body via the looksLikeHtml heuristic. When the resolved
   * format is "html" the body is structurally validated and the create is
   * rejected on failure.
   */
  format?: ArtifactFormat;
  createdByAgentId?: string;
}

/** Raised when an html-format artifact body fails structural validation. */
export class ArtifactHtmlValidationError extends Error {
  readonly line: number;
  readonly column: number;
  readonly tag?: string;
  constructor(message: string, line: number, column: number, tag?: string) {
    super(message);
    this.name = "ArtifactHtmlValidationError";
    this.line = line;
    this.column = column;
    this.tag = tag;
  }
}

export interface ListArtifactsOptions {
  taskId: string;
  kind?: string;
  namePrefix?: string;
  limit?: number;
}

/**
 * Artifact row for HTTP JSON surfaces. Inline artifacts ship as-is; file
 * artifacts never ship a body (there is none, just the caption) and instead
 * carry `description` + `file_url` so clients fetch the bytes separately.
 */
export function artifactToJson(artifact: TaskArtifact): Record<string, unknown> {
  if (artifact.storage !== "file") return { ...artifact };
  const { body, ...rest } = artifact;
  return { ...rest, description: body || artifact.description || null, file_url: `/api/artifacts/${artifact.id}/file` };
}

export class ArtifactManager {
  private db: Database;
  private artifactsRoot: string;
  private uploads: Map<string, UploadSession> = new Map();

  constructor(db?: Database, options?: { artifactsRoot?: string }) {
    this.db = db ?? getDb();
    this.artifactsRoot = options?.artifactsRoot ?? getArtifactsRoot();
  }

  // ── File artifacts (operator uploads) ──────────────────────────────────

  /**
   * Store an uploaded file as a versioned artifact: bytes on disk under
   * `<data dir>/artifacts/<taskId>/<id>.<ext>`, metadata (mime, size, sha256,
   * image dimensions) on the row, caption in `body`. Images are verified by
   * magic bytes (PNG/JPEG/WebP/GIF) and their declared mime is replaced by the
   * sniffed one; other mimes are taken as declared. Emits `artifact:created`.
   */
  createFileArtifact(input: CreateFileArtifactInput): TaskArtifact {
    if (input.kind !== "upload") {
      throw new Error(`Invalid file artifact kind: ${input.kind}. File artifacts are kind "upload".`);
    }
    const size = input.bytes.byteLength;
    if (size <= 0) throw new Error("File is empty");
    if (size > MAX_FILE_ARTIFACT_BYTES) {
      throw new Error(`File is too large (${size} bytes). The limit is ${MAX_FILE_ARTIFACT_BYTES} bytes (25 MB).`);
    }

    const declared = normalizeMime(input.mime);
    const image = detectImage(input.bytes);
    if (declared?.startsWith("image/") && !image) {
      throw new Error("Not a supported image. Images must be PNG, JPEG, WebP or GIF (checked by file signature).");
    }
    const mime = image ? image.mime : (declared ?? "application/octet-stream");
    const width = image ? (image.width || input.width || null) : null;
    const height = image ? (image.height || input.height || null) : null;

    const name = sanitizeArtifactFileName(input.name);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const id = crypto.randomUUID();
    const ext = fileExtensionFor(name, mime);

    const dir = taskArtifactDir(this.artifactsRoot, input.taskId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${id}.${ext}`);
    writeFileSync(filePath, input.bytes);

    try {
      const maxVersionRow = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) as max_version FROM task_artifacts WHERE task_id = ? AND name = ?")
        .get(input.taskId, name) as { max_version: number };
      const version = maxVersionRow.max_version + 1;
      this.db
        .prepare(
          `INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, format, created_by_agent_id,
             storage, mime, bytes, sha256, width, height, source)
           VALUES (?, ?, ?, ?, 'upload', ?, ?, NULL, ?, 'file', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          name,
          version,
          input.description?.trim() || null,
          input.description?.trim() ?? "",
          input.source,
          mime,
          size,
          sha256,
          width,
          height,
          input.source,
        );

      eventBus.emit("artifact:created", {
        artifactId: id,
        taskId: input.taskId,
        name,
        version,
        kind: "upload",
      });
    } catch (err) {
      try { unlinkSync(filePath); } catch { /* best effort: leave no orphan file */ }
      throw err;
    }

    return this.getArtifactById(id)!;
  }

  /** Absolute path of a file artifact's bytes (null for inline artifacts). */
  getArtifactFilePath(artifact: Pick<TaskArtifact, "id" | "task_id" | "name" | "mime" | "storage">): string | null {
    if (artifact.storage !== "file") return null;
    return join(taskArtifactDir(this.artifactsRoot, artifact.task_id), `${artifact.id}.${fileExtensionFor(artifact.name, artifact.mime)}`);
  }

  /** Bytes of a file artifact; null when the artifact is unknown, inline, or its file is gone. */
  readArtifactBytes(id: string): { artifact: TaskArtifact; bytes: Uint8Array } | null {
    const artifact = this.getArtifactById(id);
    if (!artifact || artifact.storage !== "file") return null;
    const path = this.getArtifactFilePath(artifact)!;
    if (!existsSync(path)) return null;
    return { artifact, bytes: new Uint8Array(readFileSync(path)) };
  }

  // ── Chunked upload sessions (connect) ───────────────────────────────────
  // In-memory only: begin → append sequential chunks → commit verifies size +
  // sha256 and creates the artifact. Sessions expire after 2 idle minutes.

  beginUpload(input: BeginUploadInput): string {
    this.pruneUploads();
    if (input.kind !== "upload") throw new Error("Upload kind must be \"upload\"");
    if (!input.name?.trim()) throw new Error("name is required");
    if (!Number.isInteger(input.bytes) || input.bytes <= 0) throw new Error("bytes must be a positive integer");
    if (input.bytes > MAX_FILE_ARTIFACT_BYTES) {
      throw new Error(`File is too large (${input.bytes} bytes). The limit is ${MAX_FILE_ARTIFACT_BYTES} bytes (25 MB).`);
    }
    if (!/^[0-9a-f]{64}$/i.test(input.sha256 ?? "")) throw new Error("sha256 must be a 64-character hex digest");
    if (input.mime && !normalizeMime(input.mime)) throw new Error(`Invalid mime type: ${input.mime}`);
    const uploadId = crypto.randomUUID();
    this.uploads.set(uploadId, {
      input: { ...input, mime: normalizeMime(input.mime), sha256: input.sha256.toLowerCase() },
      chunks: [],
      received: 0,
      nextIndex: 0,
      expiresAt: Date.now() + UPLOAD_SESSION_TTL_MS,
    });
    return uploadId;
  }

  appendChunk(uploadId: string, index: number, data: Uint8Array): { received: number } {
    const session = this.requireUpload(uploadId);
    if (index !== session.nextIndex) {
      throw new Error(`Out-of-order chunk: expected index ${session.nextIndex}, got ${index}`);
    }
    if (session.received + data.byteLength > session.input.bytes) {
      this.uploads.delete(uploadId);
      throw new Error("Upload exceeds the declared size");
    }
    session.chunks.push(data);
    session.received += data.byteLength;
    session.nextIndex += 1;
    session.expiresAt = Date.now() + UPLOAD_SESSION_TTL_MS;
    return { received: session.received };
  }

  commitUpload(uploadId: string): TaskArtifact {
    const session = this.requireUpload(uploadId);
    this.uploads.delete(uploadId);
    if (session.received !== session.input.bytes) {
      throw new Error(`Upload incomplete: received ${session.received} of ${session.input.bytes} bytes`);
    }
    const bytes = new Uint8Array(session.received);
    let offset = 0;
    for (const chunk of session.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== session.input.sha256) {
      throw new Error("Upload checksum mismatch: sha256 does not match the declared digest");
    }
    return this.createFileArtifact({
      taskId: session.input.taskId,
      name: session.input.name,
      kind: "upload",
      mime: session.input.mime,
      bytes,
      description: session.input.description,
      source: session.input.source,
    });
  }

  abortUpload(uploadId: string): boolean {
    return this.uploads.delete(uploadId);
  }

  private requireUpload(uploadId: string): UploadSession {
    const session = this.uploads.get(uploadId);
    if (!session) throw new Error("Unknown or expired upload");
    if (session.expiresAt < Date.now()) {
      this.uploads.delete(uploadId);
      throw new Error("Unknown or expired upload");
    }
    return session;
  }

  private pruneUploads(): void {
    const now = Date.now();
    for (const [id, session] of this.uploads) {
      if (session.expiresAt < now) this.uploads.delete(id);
    }
  }

  createArtifact(input: CreateArtifactInput): TaskArtifact {
    if (!VALID_KINDS.has(input.kind)) {
      throw new Error(`Invalid artifact kind: ${input.kind}. Must be one of: ${Array.from(VALID_KINDS).join(", ")}`);
    }

    if (input.format !== undefined && !VALID_FORMATS.has(input.format)) {
      throw new Error(`Invalid artifact format: ${input.format}. Must be one of: ${Array.from(VALID_FORMATS).join(", ")}`);
    }

    // Resolve format: explicit wins; otherwise infer from the body. Only the
    // resolved "html" case is structurally validated — markdown is never
    // rejected.
    const format: ArtifactFormat = input.format ?? (looksLikeHtml(input.body) ? "html" : "markdown");
    if (format === "html") {
      const validation = validateArtifactHtml(input.body);
      if (!validation.ok) {
        throw new ArtifactHtmlValidationError(
          `Artifact HTML is invalid and was not saved: ${validation.message}. Fix the markup, or set format:"markdown" if this is not HTML.`,
          validation.line,
          validation.column,
          validation.tag,
        );
      }
    }

    const id = crypto.randomUUID();

    // Auto-increment version for (task_id, name)
    const maxVersionRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) as max_version FROM task_artifacts WHERE task_id = ? AND name = ?",
      )
      .get(input.taskId, input.name) as { max_version: number };
    const version = maxVersionRow.max_version + 1;

    this.db
      .prepare(
        `INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, format, created_by_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.name,
        version,
        input.kind,
        input.description ?? null,
        input.body,
        format,
        input.createdByAgentId ?? null,
      );

    eventBus.emit("artifact:created", {
      artifactId: id,
      taskId: input.taskId,
      name: input.name,
      version,
      kind: input.kind,
    });

    return this.getArtifactById(id)!;
  }

  getArtifactById(id: string): TaskArtifact | null {
    const row = this.db
      .prepare("SELECT * FROM task_artifacts WHERE id = ?")
      .get(id) as TaskArtifact | null;
    return row ?? null;
  }

  getArtifact(taskId: string, name: string, version: "latest" | number = "latest"): TaskArtifact | null {
    if (version === "latest") {
      return this.db
        .prepare(
          "SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1",
        )
        .get(taskId, name) as TaskArtifact | null;
    }

    return this.db
      .prepare(
        "SELECT * FROM task_artifacts WHERE task_id = ? AND name = ? AND version = ?",
      )
      .get(taskId, name, version) as TaskArtifact | null;
  }

  listArtifacts(options: ListArtifactsOptions): ArtifactListItem[] {
    // Soft-deleted artifacts are excluded from the list — this feeds agent
    // context injection (buildArtifactSection), so retracted artifacts must not
    // reach the "AVAILABLE ARTIFACTS" block. Direct getArtifact-by-name still works.
    const conditions = ["task_id = ?", "deleted_at IS NULL"];
    const params: (string | number)[] = [options.taskId];

    if (options.kind) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }

    if (options.namePrefix) {
      conditions.push("name LIKE ?");
      params.push(`${options.namePrefix}%`);
    }

    const limit = options.limit ?? 100;
    const sql = `SELECT id, name, version, kind, description, created_by_agent_id, created_at,
                        storage, mime, bytes, width, height
                 FROM task_artifacts
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as ArtifactListItem[];
  }

  listVersions(taskId: string, name: string): Array<{ version: number; kind: string; description: string | null; created_at: string }> {
    return this.db
      .prepare(
        `SELECT version, kind, description, created_at
         FROM task_artifacts
         WHERE task_id = ? AND name = ?
         ORDER BY version DESC`,
      )
      .all(taskId, name) as Array<{ version: number; kind: string; description: string | null; created_at: string }>;
  }

  publishArtifact(id: string): TaskArtifact | null {
    const artifact = this.getArtifactById(id);
    if (!artifact) return null;
    // Key is stable per version: generated on first publish, reused on
    // republish so the public URL never changes for this version.
    const key = artifact.publish_key ?? crypto.randomUUID();
    this.db
      .prepare("UPDATE task_artifacts SET publish_key = ?, published_at = datetime('now') WHERE id = ?")
      .run(key, id);
    const updated = this.getArtifactById(id);
    if (updated) {
      eventBus.emit("artifact:published", {
        artifactId: id,
        taskId: updated.task_id,
        name: updated.name,
        version: updated.version,
        publishedAt: updated.published_at,
      });
    }
    return updated;
  }

  unpublishArtifact(id: string): TaskArtifact | null {
    const artifact = this.getArtifactById(id);
    if (!artifact) return null;
    this.db.prepare("UPDATE task_artifacts SET published_at = NULL WHERE id = ?").run(id);
    const updated = this.getArtifactById(id);
    if (updated) {
      eventBus.emit("artifact:unpublished", {
        artifactId: id,
        taskId: updated.task_id,
        name: updated.name,
        version: updated.version,
        publishedAt: null,
      });
    }
    return updated;
  }

  getPublishedArtifact(id: string, key: string): TaskArtifact | null {
    const artifact = this.db
      .prepare("SELECT * FROM task_artifacts WHERE id = ? AND published_at IS NOT NULL")
      .get(id) as TaskArtifact | null;
    if (!artifact?.publish_key || !key) return null;
    const expected = Buffer.from(artifact.publish_key);
    const provided = Buffer.from(key);
    if (expected.length !== provided.length) return null;
    if (!timingSafeEqual(expected, provided)) return null;
    return artifact;
  }

}
