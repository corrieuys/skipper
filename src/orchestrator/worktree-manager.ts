import type { Database } from "bun:sqlite";
import { resolve, join } from "path";
import { logError } from "../logging";

const WORKTREE_DIR = ".skipper-worktrees";

interface WorktreeRow {
  id: string;
  task_id: string;
  phase_index: number;
  delegation_group_id: string;
  agent_instance_id: string;
  worktree_path: string;
  branch_name: string;
  status: "active" | "completed" | "failed" | "cleaned";
  diff_snapshot: string | null;
  created_at: string;
  cleaned_at: string | null;
}

export class WorktreeManager {
  constructor(private readonly db: Database) {}

  async createWorktree(input: {
    taskId: string;
    phaseIndex: number;
    delegationGroupId: string;
    agentInstanceId: string;
    baseDir: string;
  }): Promise<{ worktreePath: string; branchName: string }> {
    const shortId = input.agentInstanceId.slice(0, 8);
    const shortTask = input.taskId.slice(0, 8);
    const branchName = `consensus/${shortTask}/${input.phaseIndex}/${shortId}`;
    const worktreeBase = resolve(input.baseDir, WORKTREE_DIR);
    const worktreePath = join(worktreeBase, shortId);

    await this.ensureGitignore(input.baseDir);

    const addResult = Bun.spawnSync({
      cmd: ["git", "worktree", "add", worktreePath, "-b", branchName],
      cwd: input.baseDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (addResult.exitCode !== 0) {
      const stderr = addResult.stderr.toString().trim();
      throw new Error(`Failed to create git worktree: ${stderr}`);
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO consensus_worktrees (id, task_id, phase_index, delegation_group_id, agent_instance_id, worktree_path, branch_name, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(id, input.taskId, input.phaseIndex, input.delegationGroupId, input.agentInstanceId, worktreePath, branchName);

    return { worktreePath, branchName };
  }

  async captureDiff(agentInstanceId: string): Promise<string> {
    const row = this.getWorktreeRow(agentInstanceId);
    if (!row) throw new Error(`No worktree found for instance ${agentInstanceId}`);

    // Stage all changes
    Bun.spawnSync({
      cmd: ["git", "add", "-A"],
      cwd: row.worktree_path,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Capture staged diff
    const diffResult = Bun.spawnSync({
      cmd: ["git", "diff", "--cached"],
      cwd: row.worktree_path,
      stdout: "pipe",
      stderr: "pipe",
    });

    const diff = diffResult.stdout.toString();

    this.db
      .prepare("UPDATE consensus_worktrees SET diff_snapshot = ?, status = 'completed' WHERE agent_instance_id = ?")
      .run(diff, agentInstanceId);

    return diff;
  }

  async applyDiff(agentInstanceId: string, targetDir: string): Promise<void> {
    const row = this.getWorktreeRow(agentInstanceId);
    if (!row?.diff_snapshot) throw new Error(`No diff snapshot for instance ${agentInstanceId}`);

    if (row.diff_snapshot.trim().length === 0) return;

    // Write diff to temp file and apply (UUID prevents collision if concurrent)
    const tmpPath = join(targetDir, `.skipper-consensus-patch-${crypto.randomUUID()}.diff`);
    await Bun.write(tmpPath, row.diff_snapshot);

    try {
      const applyResult = Bun.spawnSync({
        cmd: ["git", "apply", "--3way", tmpPath],
        cwd: targetDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      if (applyResult.exitCode !== 0) {
        const stderr = applyResult.stderr.toString().trim();
        throw new Error(`Failed to apply diff: ${stderr}`);
      }

      // Check for unresolved conflict markers left by --3way
      const conflictCheck = Bun.spawnSync({
        cmd: ["grep", "-rn", "^<<<<<<<", "."],
        cwd: targetDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (conflictCheck.exitCode === 0) {
        throw new Error("Diff applied but left unresolved conflict markers (<<<<<<). Manual merge required.");
      }
    } finally {
      try {
        const { unlinkSync } = require("fs");
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  applyRawDiff(diffContent: string, targetDir: string): void {
    if (diffContent.trim().length === 0) return;

    const tmpPath = join(targetDir, `.skipper-consensus-merge-patch-${crypto.randomUUID()}.diff`);
    Bun.write(tmpPath, diffContent);

    try {
      const applyResult = Bun.spawnSync({
        cmd: ["git", "apply", "--3way", tmpPath],
        cwd: targetDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      if (applyResult.exitCode !== 0) {
        const stderr = applyResult.stderr.toString().trim();
        throw new Error(`Failed to apply merged diff: ${stderr}`);
      }

      // Check for unresolved conflict markers left by --3way
      const conflictCheck = Bun.spawnSync({
        cmd: ["grep", "-rn", "^<<<<<<<", "."],
        cwd: targetDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (conflictCheck.exitCode === 0) {
        throw new Error("Merged diff applied but left unresolved conflict markers (<<<<<<). Manual merge required.");
      }
    } finally {
      try {
        const { unlinkSync } = require("fs");
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
    }
  }

  async cleanupWorktree(agentInstanceId: string): Promise<void> {
    const row = this.getWorktreeRow(agentInstanceId);
    if (!row || row.status === "cleaned") return;

    try {
      Bun.spawnSync({
        cmd: ["git", "worktree", "remove", row.worktree_path, "--force"],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      // worktree may already be gone
    }

    try {
      Bun.spawnSync({
        cmd: ["git", "branch", "-D", row.branch_name],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      // branch may already be gone
    }

    this.db
      .prepare("UPDATE consensus_worktrees SET status = 'cleaned', cleaned_at = datetime('now') WHERE agent_instance_id = ?")
      .run(agentInstanceId);
  }

  async cleanupAllForGroup(delegationGroupId: string): Promise<void> {
    const rows = this.db
      .prepare("SELECT agent_instance_id FROM consensus_worktrees WHERE delegation_group_id = ? AND status != 'cleaned'")
      .all(delegationGroupId) as { agent_instance_id: string }[];

    for (const row of rows) {
      await this.cleanupWorktree(row.agent_instance_id);
    }

    // Prune dangling worktree references
    Bun.spawnSync({
      cmd: ["git", "worktree", "prune"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  cleanupStaleWorktrees(): void {
    try {
      const stale = this.db
        .prepare(
          `SELECT cw.agent_instance_id FROM consensus_worktrees cw
           JOIN tasks t ON cw.task_id = t.id
           WHERE cw.status = 'active' AND t.status IN ('completed', 'failed')`,
        )
        .all() as { agent_instance_id: string }[];

      for (const row of stale) {
        this.cleanupWorktree(row.agent_instance_id).catch((err) => {
          logError(this.db, "stale_worktree_cleanup", { instanceId: row.agent_instance_id }, err);
        });
      }
    } catch (err) {
      logError(this.db, "stale_worktree_scan", {}, err);
    }
  }

  getWorktreePath(agentInstanceId: string): string | null {
    const row = this.getWorktreeRow(agentInstanceId);
    return row?.worktree_path ?? null;
  }

  getWorktreesByGroup(delegationGroupId: string): WorktreeRow[] {
    return this.db
      .prepare("SELECT * FROM consensus_worktrees WHERE delegation_group_id = ?")
      .all(delegationGroupId) as WorktreeRow[];
  }

  isConsensusGroup(delegationGroupId: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM consensus_worktrees WHERE delegation_group_id = ? LIMIT 1")
      .get(delegationGroupId);
    return !!row;
  }

  private getWorktreeRow(agentInstanceId: string): WorktreeRow | null {
    return this.db
      .prepare("SELECT * FROM consensus_worktrees WHERE agent_instance_id = ?")
      .get(agentInstanceId) as WorktreeRow | null;
  }

  private async ensureGitignore(baseDir: string): Promise<void> {
    const gitignorePath = join(baseDir, ".gitignore");
    try {
      const existing = await Bun.file(gitignorePath).text();
      if (!existing.includes(WORKTREE_DIR)) {
        await Bun.write(gitignorePath, existing.trimEnd() + `\n${WORKTREE_DIR}/\n`);
      }
    } catch {
      // .gitignore doesn't exist or can't be read — create it
      await Bun.write(gitignorePath, `${WORKTREE_DIR}/\n`);
    }
  }
}
