import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { eventBus } from "../events/bus";

export interface TaskArtifact {
  id: string;
  task_id: string;
  name: string;
  version: number;
  kind: ArtifactKind;
  description: string | null;
  body: string;
  created_by_agent_id: string | null;
  created_at: string;
}

export type ArtifactKind = "transcript" | "summary" | "plan" | "other";

const VALID_KINDS = new Set<string>(["transcript", "summary", "plan", "other"]);

export interface ArtifactListItem {
  id: string;
  name: string;
  version: number;
  kind: string;
  description: string | null;
  created_by_agent_id: string | null;
  created_at: string;
}

export interface CreateArtifactInput {
  taskId: string;
  name: string;
  kind: ArtifactKind;
  description?: string;
  body: string;
  createdByAgentId?: string;
}

export interface ListArtifactsOptions {
  taskId: string;
  kind?: string;
  namePrefix?: string;
  limit?: number;
}

export class ArtifactManager {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
  }

  createArtifact(input: CreateArtifactInput): TaskArtifact {
    if (!VALID_KINDS.has(input.kind)) {
      throw new Error(`Invalid artifact kind: ${input.kind}. Must be one of: ${Array.from(VALID_KINDS).join(", ")}`);
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
        `INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, created_by_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.name,
        version,
        input.kind,
        input.description ?? null,
        input.body,
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
    const conditions = ["task_id = ?"];
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
    const sql = `SELECT id, name, version, kind, description, created_by_agent_id, created_at
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

}
