import type { Database } from "bun:sqlite";
import type { AgentManager } from "../agents/manager";
import type { PromptBuilder, AgentInfo, PhaseInfo } from "../agents/prompt-builder";
import type { TaskScheduler } from "../tasks/scheduler";
import type { Task } from "../tasks/scheduler";
import type { ArtifactManager, TaskArtifact } from "./artifact-manager";
import type { WorktreeManager } from "./worktree-manager";
import type { Phase, ConsensusConfig } from "../teams/manager";
import type { OrchestrationState } from "./types";
import { agentTypeUsesInlinePrompt, getAgentTypeDefinition } from "../agents/types";
import { eventBus } from "../events/bus";
import { logError } from "../logging";
import { MAX_DELEGATION_RESULT_CHARS, truncateResult } from "./delegation-manager";
import { resolvePhaseConfig } from "./phase-config";

const REVIEWER_TERMINAL_OUTPUT_CHARS = 5_000;
const REVIEWER_RETRY_LIMIT = 1;

interface ConsensusGroupMeta {
  groupId: string;
  taskId: string;
  phaseIndex: number;
  totalPhases: number;
  phaseName: string;
  entrypointAgentId: string;
  consensus: ConsensusConfig;
}

export class ConsensusManager {
  private reviewerRetries: Map<string, number> = new Map(); // groupId -> retry count
  private activeReviewerInstances: Map<string, string> = new Map(); // groupId -> reviewer instanceId
  private reviewStartGuard: Set<string> = new Set(); // prevents double-start of consensus review

  constructor(
    private readonly db: Database,
    private readonly agentManager: AgentManager,
    private readonly promptBuilder: PromptBuilder,
    private readonly taskScheduler: TaskScheduler,
    private readonly worktreeManager: WorktreeManager,
    private readonly artifactManager: ArtifactManager,
    private readonly updateOrchestrationState: (taskId: string, state: OrchestrationState) => void,
    private readonly writeCheckpoint: (taskId: string, type: string, snapshot?: Record<string, unknown>) => void,
  ) {}

  hasConsensus(consensus: ConsensusConfig | null | undefined): boolean {
    return !!consensus && consensus.agent_count >= 2;
  }

  async startConsensusPhase(input: {
    task: Task;
    entrypointAgentId: string;
    phase: Phase;
    phaseIndex: number;
    totalPhases: number;
  }): Promise<void> {
    const { task, entrypointAgentId, phase, phaseIndex, totalPhases } = input;
    const consensus = phase.consensus!;
    const agentCount = consensus.agent_count;
    // Worktrees are created in the target repo; agents spawn in orchestrator cwd
    const worktreeBaseDir = task.working_directory || process.cwd();
    const agentWorkingDir = process.cwd();

    // Create delegation group (no parent instance — consensus is orchestrator-driven)
    const groupId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO delegation_groups (id, task_id, parent_instance_id, policy, expected_count, status)
         VALUES (?, ?, ?, 'wait_all_mixed', ?, 'running')`,
      )
      .run(groupId, task.id, entrypointAgentId, agentCount);

    // Store consensus metadata on the group for later retrieval
    this.db
      .prepare(
        `UPDATE delegation_groups SET policy = ? WHERE id = ?`,
      )
      .run(JSON.stringify({
        type: "consensus",
        phase_index: phaseIndex,
        total_phases: totalPhases,
        phase_name: phase.name,
        entrypoint_agent_id: entrypointAgentId,
        consensus,
      }), groupId);

    const agent = this.agentManager.getAgent(entrypointAgentId);
    if (!agent) {
      this.taskScheduler.failTask(task.id, "Entrypoint agent not found for consensus phase");
      return;
    }

    const typeDef = getAgentTypeDefinition(agent.type, this.db);
    const isStreaming = typeDef?.supports_stdin ?? false;

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      type: agent.type,
      instruction: agent.config.instruction,
    };

    const phaseInfo: PhaseInfo = {
      name: phase.name,
      prompt: phase.prompt,
      index: phaseIndex,
      total: totalPhases,
    };

    const useWorktree = consensus.worktree ?? true;

    let spawnedCount = 0;
    for (let i = 0; i < agentCount; i++) {
      const instanceId = crypto.randomUUID();
      const delegationId = crypto.randomUUID();

      try {
        let workingDir = agentWorkingDir;

        if (useWorktree) {
          // Create worktree in the target repo for isolated file changes
          const { worktreePath } = await this.worktreeManager.createWorktree({
            taskId: task.id,
            phaseIndex,
            delegationGroupId: groupId,
            agentInstanceId: instanceId,
            baseDir: worktreeBaseDir,
          });
          workingDir = worktreePath;
        } else {
          // No worktree — track consensus instance via lightweight row (empty path/branch)
          this.db
            .prepare(
              `INSERT INTO consensus_worktrees (id, task_id, phase_index, delegation_group_id, agent_instance_id, worktree_path, branch_name, status)
               VALUES (?, ?, ?, ?, ?, '', '', 'active')`,
            )
            .run(crypto.randomUUID(), task.id, phaseIndex, groupId, instanceId);
        }

        // Create agent instance
        this.db
          .prepare(
            `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, attempt)
             VALUES (?, ?, ?, ?, ?, 'pending', 1)`,
          )
          .run(instanceId, task.id, entrypointAgentId, null, entrypointAgentId);

        // Create delegation record
        this.db
          .prepare(
            `INSERT INTO delegations (id, parent_agent_id, child_agent_id, parent_instance_id, child_instance_id, delegation_group_id, task_id, prompt, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(delegationId, entrypointAgentId, entrypointAgentId, entrypointAgentId, instanceId, groupId, task.id, phase.prompt);

        // Build prompt with consensus context
        const shortId = instanceId.slice(0, 8);
        const { prompt, noteIds } = this.promptBuilder.buildInitialPromptTracked({
          agent: agentInfo,
          task: { id: task.id, title: task.title, description: task.description ?? undefined, workingDirectory: task.working_directory },
          phase: phaseInfo,
          isStreaming,
          consensusContext: {
            agentIndex: i,
            totalAgents: agentCount,
            shortId,
            worktreePath: useWorktree ? worktreeBaseDir : undefined,
          },
        }, instanceId);

        const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;

        // Spawn agent — always in orchestrator cwd (worktree is for delegated children)
        await this.agentManager.spawnAgentInstance(entrypointAgentId, instanceId, {
          workingDir: agentWorkingDir,
          taskId: task.id,
          parentInstanceId: null,
          rootInstanceId: entrypointAgentId,
          attempt: 1,
          initialPrompt: usesInlinePrompt ? prompt : undefined,
        });

        // Update delegation to running
        this.db
          .prepare("UPDATE delegations SET status = 'running' WHERE id = ?")
          .run(delegationId);
        this.db
          .prepare("UPDATE agent_instances SET status = 'running' WHERE id = ?")
          .run(instanceId);

        // Send prompt if not inline
        if (!usesInlinePrompt) {
          const closeStdin = !isStreaming;
          this.agentManager.sendInput(instanceId, prompt, closeStdin);
        }

        if (noteIds.length > 0) {
          this.promptBuilder.recordNoteDelivery(instanceId, noteIds);
        }

        spawnedCount++;

        eventBus.emit("instance:state_changed", {
          instanceId,
          templateAgentId: entrypointAgentId,
          taskId: task.id,
          parentInstanceId: null,
          rootInstanceId: entrypointAgentId,
          status: "running",
        });
      } catch (err) {
        logError(this.db, "consensus_spawn_agent", { taskId: task.id, instanceId, workerIndex: i }, err);
        this.db.prepare("UPDATE delegations SET status = 'failed' WHERE id = ?").run(delegationId);
        this.db.prepare("UPDATE agent_instances SET status = 'failed' WHERE id = ?").run(instanceId);
      }
    }

    if (spawnedCount === 0) {
      this.taskScheduler.failTask(task.id, "Failed to spawn any consensus agents");
      return;
    }

    // Update expected count if some failed to spawn
    if (spawnedCount < agentCount) {
      this.db
        .prepare("UPDATE delegation_groups SET expected_count = ? WHERE id = ?")
        .run(spawnedCount, groupId);
    }

    this.updateOrchestrationState(task.id, {
      step: "WAITING_CONSENSUS",
      last_checkpoint_ts: new Date().toISOString(),
      session_id: null,
      active_delegation_group_id: groupId,
      active_delegation_child_count: spawnedCount,
      active_delegation_settled_count: 0,
      phase_guards: [],
      pending_regression: null,
      checkpoint_prompt_hash: null,
    });

    this.writeCheckpoint(task.id, "CONSENSUS_START", {
      phase: phaseIndex,
      group_id: groupId,
      agent_count: spawnedCount,
      strategy: consensus.strategy,
    });
  }

  async handleConsensusAgentExit(instanceId: string, exitCode: number): Promise<boolean> {
    const worktree = this.db
      .prepare("SELECT * FROM consensus_worktrees WHERE agent_instance_id = ?")
      .get(instanceId) as { delegation_group_id: string; status: string } | null;

    if (!worktree) return false; // Not a consensus agent

    const failed = exitCode !== 0;

    // Check if this consensus uses worktrees (worktree_path is non-empty)
    const hasWorktree = !!(worktree as any).worktree_path;

    try {
      if (!failed) {
        if (hasWorktree) {
          await this.worktreeManager.captureDiff(instanceId);
        } else {
          // No worktree — just mark as completed (artifacts/notes already stored)
          this.db
            .prepare("UPDATE consensus_worktrees SET status = 'completed' WHERE agent_instance_id = ?")
            .run(instanceId);
        }
      } else {
        this.db
          .prepare("UPDATE consensus_worktrees SET status = 'failed' WHERE agent_instance_id = ?")
          .run(instanceId);
      }
    } catch (err) {
      logError(this.db, "consensus_capture_diff", { instanceId }, err);
      this.db
        .prepare("UPDATE consensus_worktrees SET status = 'failed' WHERE agent_instance_id = ?")
        .run(instanceId);
    }

    // Update delegation status
    const delegation = this.db
      .prepare("SELECT id, parent_agent_id, task_id FROM delegations WHERE child_instance_id = ? AND delegation_group_id = ?")
      .get(instanceId, worktree.delegation_group_id) as { id: string; parent_agent_id: string; task_id: string } | null;

    if (delegation) {
      this.db
        .prepare("UPDATE delegations SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?")
        .run(failed ? "failed" : "completed", failed ? "Agent failed" : "Consensus agent completed", delegation.id);
    }

    // Update agent instance
    this.db
      .prepare("UPDATE agent_instances SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(failed ? "failed" : "completed", instanceId);

    // Update group progress
    const group = this.db
      .prepare("SELECT * FROM delegation_groups WHERE id = ?")
      .get(worktree.delegation_group_id) as {
        id: string; task_id: string; parent_instance_id: string;
        expected_count: number; settled_count: number; failed_count: number; status: string;
      } | null;

    if (!group || group.status !== "running") return true;

    const updated = this.db
      .prepare(
        `UPDATE delegation_groups
         SET settled_count = settled_count + 1,
             failed_count = failed_count + ?,
             completed_at = CASE WHEN settled_count + 1 >= expected_count THEN datetime('now') ELSE completed_at END,
             status = CASE WHEN settled_count + 1 >= expected_count THEN 'completed' ELSE status END
         WHERE id = ?
         RETURNING *`,
      )
      .get(failed ? 1 : 0, worktree.delegation_group_id) as typeof group | null;

    if (!updated) return true;

    eventBus.emit("delegation_group:progress", {
      groupId: worktree.delegation_group_id,
      taskId: group.task_id,
      parentInstanceId: group.parent_instance_id,
      settledCount: updated.settled_count,
      expectedCount: updated.expected_count,
      failedCount: updated.failed_count,
      status: updated.status,
    });

    if (updated.settled_count >= updated.expected_count) {
      // Check if too many failed
      if (updated.failed_count >= Math.ceil(updated.expected_count / 2)) {
        this.escalateConsensusFailed(group.task_id, worktree.delegation_group_id, updated.failed_count, updated.expected_count);
        await this.worktreeManager.cleanupAllForGroup(worktree.delegation_group_id);
      } else {
        await this.startConsensusReview(worktree.delegation_group_id);
      }
    }

    return true;
  }

  async startConsensusReview(groupId: string): Promise<void> {
    // Guard against double-start from simultaneous agent exits
    if (this.reviewStartGuard.has(groupId)) return;
    this.reviewStartGuard.add(groupId);

    // Also check DB — if group is no longer running, another path already handled it
    const groupStatus = this.db
      .prepare("SELECT status FROM delegation_groups WHERE id = ?")
      .get(groupId) as { status: string } | null;
    if (!groupStatus || groupStatus.status !== "completed") {
      // Group must be 'completed' (all agents settled) to start review
      // If it's still 'running', agents haven't all finished yet
      // If it's something else, it was already handled
      if (groupStatus?.status !== "completed") {
        this.reviewStartGuard.delete(groupId);
        return;
      }
    }

    const meta = this.getGroupMeta(groupId);
    if (!meta) {
      logError(this.db, "consensus_review_no_meta", { groupId });
      this.reviewStartGuard.delete(groupId);
      return;
    }

    const worktrees = this.worktreeManager.getWorktreesByGroup(groupId);
    const successfulWorktrees = worktrees.filter((w) => w.status === "completed");

    if (successfulWorktrees.length === 0) {
      this.escalateConsensusFailed(meta.taskId, groupId, worktrees.length, worktrees.length);
      await this.worktreeManager.cleanupAllForGroup(groupId);
      this.reviewStartGuard.delete(groupId);
      return;
    }

    const useWorktree = meta.consensus.worktree ?? true;
    const validShortIds = successfulWorktrees.map((w) => w.agent_instance_id.slice(0, 8));

    // Build reviewer prompt — different content for worktree vs non-worktree
    const agentSections: string[] = [];
    for (let i = 0; i < successfulWorktrees.length; i++) {
      const w = successfulWorktrees[i];
      const shortId = w.agent_instance_id.slice(0, 8);
      const terminalOutput = this.getTerminalOutputSummary(w.agent_instance_id, REVIEWER_TERMINAL_OUTPUT_CHARS);

      // Get artifacts for this agent
      const artifacts = this.db
        .prepare("SELECT name, kind, version, body FROM task_artifacts WHERE task_id = ? AND created_by_agent_id = ?")
        .all(meta.taskId, w.agent_instance_id) as { name: string; kind: string; version: number; body: string | null }[];

      // Get notes for this agent
      const notes = this.db
        .prepare("SELECT content FROM task_notes WHERE task_id = ? AND agent_id = ? ORDER BY created_at")
        .all(meta.taskId, w.agent_instance_id) as { content: string }[];

      const notesList = notes.length > 0
        ? notes.map((n) => `- ${n.content}`).join("\n")
        : "(none)";

      if (useWorktree) {
        const artifactList = artifacts.length > 0
          ? artifacts.map((a) => `- ${a.name} (${a.kind}, v${a.version})`).join("\n")
          : "(none)";
        const diff = w.diff_snapshot
          ? truncateResult(w.diff_snapshot, MAX_DELEGATION_RESULT_CHARS)
          : "(no changes)";

        agentSections.push(`## Agent ${i + 1} (${shortId})
### Git Diff:
\`\`\`diff
${diff}
\`\`\`
### Notes:
${notesList}
### Artifacts:
${artifactList}
### Terminal Output (last ${REVIEWER_TERMINAL_OUTPUT_CHARS} chars):
${terminalOutput || "(no output)"}`);
      } else {
        // Non-worktree: show artifacts with body content, notes, and output
        const artifactBodies = artifacts.length > 0
          ? artifacts.map((a) => {
              const body = a.body ? truncateResult(a.body, 3000) : "(empty)";
              return `#### ${a.name} (${a.kind}, v${a.version})\n${body}`;
            }).join("\n\n")
          : "(none)";

        agentSections.push(`## Agent ${i + 1} (${shortId})
### Notes:
${notesList}
### Artifacts:
${artifactBodies}
### Terminal Output (last ${REVIEWER_TERMINAL_OUTPUT_CHARS} chars):
${terminalOutput || "(no output)"}`);
      }
    }

    const mergeInstruction = useWorktree
      ? `\nor call \`consensus_merge({ diff: "<unified diff (git format) to apply to the main working directory>" })\``
      : "";

    // Get task description for evaluation criteria
    const task = this.taskScheduler.getTask(meta.taskId);
    const taskContext = task
      ? `Task: ${task.title}\n${task.description ? `Requirements: ${task.description}` : ""}`
      : "";

    // Detect QA/review phase — agreement mode vs competitive mode
    const phaseNameLower = meta.phaseName.toLowerCase();
    const isQAPhase = phaseNameLower.includes("review") || phaseNameLower.includes("qa") || phaseNameLower.includes("validation") || phaseNameLower.includes("test");

    let instructions: string;
    if (isQAPhase) {
      // QA consensus: check if agents agree the result is correct
      instructions = `## Instructions
Review the QA/review outputs above from ${successfulWorktrees.length} agents that independently verified phase "${meta.phaseName}".

${taskContext}

This is a QA consensus — the question is NOT which review is "best", but whether the agents AGREE the work is correct.

Evaluate each agent's findings against the task requirements above. Then:
- If the MAJORITY of agents agree the work PASSES (no blocking issues found): Pick any passing agent's output.
  Call \`consensus_pick({ agent_short_id: "<shortId>" })\`
- If the MAJORITY of agents found FAILURES or blocking issues: Pick the agent with the most thorough failure analysis.
  Call \`consensus_pick({ agent_short_id: "<shortId>" })\`
  The phase will be regressed based on their findings.

Valid agent IDs: ${validShortIds.join(", ")}`;
    } else {
      // Competitive consensus: pick best output
      instructions = `## Instructions
Review the outputs above from ${successfulWorktrees.length} agents that worked on phase "${meta.phaseName}" in parallel.

${taskContext}

Evaluate each agent's output against the task requirements above. Pick the output that best satisfies the requirements — considering correctness, completeness, and quality.

Strategy: '${meta.consensus.strategy}'.
- best_of: Pick the single best output
- merge: Combine the best parts of each${useWorktree ? " into a unified diff" : ""}

Call \`consensus_pick({ agent_short_id: "<shortId>" })\` where <shortId> is one of: ${validShortIds.join(", ")}
${mergeInstruction}`;
    }

    const reviewerPrompt = `[CONSENSUS_REVIEW phase:${meta.phaseName} strategy:${meta.consensus.strategy}]

${agentSections.join("\n\n---\n\n")}

---

${instructions}`;

    // Determine reviewer agent
    const reviewerAgentId = meta.consensus.reviewer_agent_id ?? meta.entrypointAgentId;
    const reviewer = this.agentManager.getAgent(reviewerAgentId);
    if (!reviewer) {
      logError(this.db, "consensus_reviewer_not_found", { reviewerAgentId, groupId });
      this.taskScheduler.failTask(meta.taskId, `Consensus reviewer agent not found: ${reviewerAgentId}`);
      await this.worktreeManager.cleanupAllForGroup(groupId);
      this.reviewStartGuard.delete(groupId);
      return;
    }

    const reviewerInstanceId = crypto.randomUUID();
    this.activeReviewerInstances.set(groupId, reviewerInstanceId);

    const typeDef = getAgentTypeDefinition(reviewer.type, this.db);
    const usesInlinePrompt = typeDef ? agentTypeUsesInlinePrompt(typeDef) : false;
    const isStreaming = typeDef?.supports_stdin ?? false;

    // Create reviewer instance (with metadata to identify it as consensus reviewer)
    this.db
      .prepare(
        `INSERT INTO agent_instances (id, task_id, template_agent_id, parent_instance_id, root_instance_id, status, attempt, state_metadata)
         VALUES (?, ?, ?, NULL, ?, 'running', 1, '{"role":"consensus_reviewer"}')`,
      )
      .run(reviewerInstanceId, meta.taskId, reviewerAgentId, reviewerAgentId);

    try {
      const task = this.taskScheduler.getTask(meta.taskId);
      const reviewerWorkingDir = process.cwd(); // Reviewer runs in orchestrator cwd
      await this.agentManager.spawnAgentInstance(reviewerAgentId, reviewerInstanceId, {
        workingDir: reviewerWorkingDir,
        taskId: meta.taskId,
        parentInstanceId: null,
        rootInstanceId: reviewerAgentId,
        attempt: 1,
        initialPrompt: usesInlinePrompt ? reviewerPrompt : undefined,
      });

      if (!usesInlinePrompt) {
        const closeStdin = !isStreaming;
        this.agentManager.sendInput(reviewerInstanceId, reviewerPrompt, closeStdin);
      }

      this.writeCheckpoint(meta.taskId, "CONSENSUS_REVIEW_START", {
        group_id: groupId,
        reviewer_instance_id: reviewerInstanceId,
        successful_agents: successfulWorktrees.length,
      });
    } catch (err) {
      logError(this.db, "consensus_reviewer_spawn", { groupId, reviewerAgentId }, err);
      this.taskScheduler.failTask(meta.taskId, `Failed to spawn consensus reviewer: ${err instanceof Error ? err.message : String(err)}`);
      await this.worktreeManager.cleanupAllForGroup(groupId);
      this.reviewStartGuard.delete(groupId);
    }
  }

  async handleConsensusPick(reviewerInstanceId: string, pickedShortId: string): Promise<void> {
    const groupId = this.findGroupForReviewer(reviewerInstanceId);
    if (!groupId) return;

    const meta = this.getGroupMeta(groupId);
    if (!meta) return;

    const useWorktree = meta.consensus.worktree ?? true;

    // Find the full instance ID from the short ID
    const worktrees = this.worktreeManager.getWorktreesByGroup(groupId);
    const validShortIds = worktrees.filter(w => w.status === "completed").map(w => w.agent_instance_id.slice(0, 8));
    const picked = worktrees.find((w) => w.agent_instance_id.startsWith(pickedShortId) && w.status === "completed");

    if (!picked) {
      logError(this.db, "consensus_pick_not_found", { groupId, pickedShortId, validShortIds });
      this.taskScheduler.failTask(meta.taskId, `Consensus pick not found: ${pickedShortId}. Valid: ${validShortIds.join(", ")}`);
      if (useWorktree) await this.worktreeManager.cleanupAllForGroup(groupId);
      return;
    }

    if (useWorktree) {
      if (!picked.diff_snapshot) {
        logError(this.db, "consensus_pick_no_diff", { groupId, pickedShortId });
        this.taskScheduler.failTask(meta.taskId, `Picked agent has no diff: ${pickedShortId}`);
        await this.worktreeManager.cleanupAllForGroup(groupId);
        return;
      }

      const pickTask = this.taskScheduler.getTask(meta.taskId);
      const pickBaseDir = pickTask?.working_directory || process.cwd();
      try {
        await this.worktreeManager.applyDiff(picked.agent_instance_id, pickBaseDir);
      } catch (err) {
        logError(this.db, "consensus_apply_diff", { groupId, pickedId: picked.agent_instance_id }, err);
        this.escalateApplyFailed(meta.taskId, groupId, err);
        return;
      }
    }
    // Non-worktree: no diff to apply — the picked agent's artifacts/notes are already stored

    await this.finishConsensus(groupId, meta, "pick", picked.agent_instance_id);
  }

  async handleConsensusMerge(reviewerInstanceId: string, mergedDiff: string): Promise<void> {
    const groupId = this.findGroupForReviewer(reviewerInstanceId);
    if (!groupId) return;

    const meta = this.getGroupMeta(groupId);
    if (!meta) return;

    const mergeTask = this.taskScheduler.getTask(meta.taskId);
    const mergeBaseDir = mergeTask?.working_directory || process.cwd();
    try {
      this.worktreeManager.applyRawDiff(mergedDiff, mergeBaseDir);
    } catch (err) {
      logError(this.db, "consensus_apply_merge", { groupId }, err);
      this.escalateApplyFailed(meta.taskId, groupId, err);
      return;
    }

    await this.finishConsensus(groupId, meta, "merge", null);
  }

  async handleReviewerExit(instanceId: string, exitCode: number): Promise<boolean> {
    const groupId = this.findGroupForReviewer(instanceId);
    if (!groupId) return false;

    // Check if the consensus decision was already applied (signal processed before exit)
    const groupRow = this.db
      .prepare("SELECT status FROM delegation_groups WHERE id = ?")
      .get(groupId) as { status: string } | null;

    // If finishConsensus already ran, the group's worktrees are cleaned and guard is cleared.
    // Don't retry or escalate — the decision was already made.
    if (!groupRow || !this.activeReviewerInstances.has(groupId)) {
      return true;
    }

    if (exitCode !== 0) {
      const retries = this.reviewerRetries.get(groupId) ?? 0;
      if (retries < REVIEWER_RETRY_LIMIT) {
        this.reviewerRetries.set(groupId, retries + 1);
        this.activeReviewerInstances.delete(groupId);
        this.reviewStartGuard.delete(groupId);
        await this.startConsensusReview(groupId);
      } else {
        const meta = this.getGroupMeta(groupId);
        if (meta) {
          this.escalateReviewerFailed(meta.taskId, groupId);
        }
        await this.worktreeManager.cleanupAllForGroup(groupId);
        this.reviewStartGuard.delete(groupId);
      }
    }
    // exit code 0 without calling consensus_pick/consensus_merge MCP tool — clean up
    return true;
  }

  isReviewerInstance(instanceId: string): boolean {
    for (const reviewerId of this.activeReviewerInstances.values()) {
      if (reviewerId === instanceId) return true;
    }
    return false;
  }

  isConsensusInstance(instanceId: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM consensus_worktrees WHERE agent_instance_id = ? LIMIT 1")
      .get(instanceId);
    return !!row;
  }

  private async finishConsensus(groupId: string, meta: ConsensusGroupMeta, method: "pick" | "merge", pickedInstanceId: string | null): Promise<void> {
    this.writeCheckpoint(meta.taskId, "CONSENSUS_COMPLETE", {
      group_id: groupId,
      method,
      picked_instance_id: pickedInstanceId,
      phase: meta.phaseIndex,
    });

    // Promote winning agent's scoped artifacts to canonical names
    if (pickedInstanceId && method === "pick") {
      const shortId = pickedInstanceId.slice(0, 8);
      // Find artifacts with the picked agent's shortId prefix
      const scopedArtifacts = this.db
        .prepare(
          `SELECT name, kind, description, body, MAX(version) as version
           FROM task_artifacts
           WHERE task_id = ? AND name LIKE ?
           GROUP BY name`,
        )
        .all(meta.taskId, `${shortId}-%`) as Array<{
          name: string; kind: string; description: string | null; body: string | null; version: number;
        }>;

      for (const art of scopedArtifacts) {
        const canonicalName = art.name.slice(shortId.length + 1);
        try {
          const existing = this.db
            .prepare("SELECT MAX(version) as mv FROM task_artifacts WHERE task_id = ? AND name = ?")
            .get(meta.taskId, canonicalName) as { mv: number | null } | null;
          const nextVersion = (existing?.mv ?? 0) + 1;

          this.db
            .prepare(
              `INSERT INTO task_artifacts (id, task_id, name, version, kind, description, body, created_by_agent_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'consensus')`,
            )
            .run(crypto.randomUUID(), meta.taskId, canonicalName, nextVersion, art.kind,
              `[Consensus winner] ${art.description ?? ""}`.trim(),
              art.body);
        } catch (err) {
          logError(this.db, "consensus_promote_artifact", { taskId: meta.taskId, name: art.name, canonicalName }, err);
        }
      }
    }

    const useWorktree = meta.consensus.worktree ?? true;
    if (useWorktree) {
      await this.worktreeManager.cleanupAllForGroup(groupId);
    } else {
      // Clean up lightweight tracking rows
      this.db.prepare("DELETE FROM consensus_worktrees WHERE delegation_group_id = ?").run(groupId);
    }

    this.activeReviewerInstances.delete(groupId);
    this.reviewerRetries.delete(groupId);
    this.reviewStartGuard.delete(groupId);

    // Advance phase or complete task
    const task = this.taskScheduler.getTask(meta.taskId);
    if (!task || task.status !== "running") return;

    // Check if phase has review: true — set needs_review before advancing
    // (consolidation is done, now the standard phase review gate applies)
    const teamRow = task.team_id
      ? this.db.prepare("SELECT phases FROM teams WHERE id = ?").get(task.team_id) as { phases: string } | null
      : null;
    let phaseHasReview = false;
    if (teamRow?.phases) {
      try {
        const phases = JSON.parse(teamRow.phases) as Phase[];
        const phase = phases[meta.phaseIndex];
        if (phase) {
          phaseHasReview = resolvePhaseConfig(phase, task.task_config as Record<string, unknown>).review;
        }
      } catch { /* ignore */ }
    }

    if (phaseHasReview) {
      // Set needs_review — user must approve before advancing
      const phaseName = phases[meta.phaseIndex]?.name;
      this.taskScheduler.setNeedsReview(meta.taskId, true, phaseName ? { phaseName, phaseIndex: meta.phaseIndex } : undefined);
      this.writeCheckpoint(meta.taskId, "PHASE_REVIEW_PENDING", { completed_phase: meta.phaseIndex });
      return;
    }

    if (meta.phaseIndex >= meta.totalPhases - 1) {
      try {
        this.taskScheduler.completeTask(meta.taskId);
      } catch (err) {
        logError(this.db, "consensus_complete_task", { taskId: meta.taskId }, err);
      }
    } else {
      // Advance to next phase
      this.taskScheduler.advancePhase(meta.taskId);
      this.updateOrchestrationState(meta.taskId, {
        step: "ADVANCING_PHASE",
        last_checkpoint_ts: new Date().toISOString(),
        session_id: null,
        active_delegation_group_id: null,
        active_delegation_child_count: 0,
        active_delegation_settled_count: 0,
        phase_guards: [],
        pending_regression: null,
        checkpoint_prompt_hash: null,
      });

      eventBus.emit("consensus:phase_advance", {
        taskId: meta.taskId,
        entrypointAgentId: meta.entrypointAgentId,
        nextPhaseIndex: meta.phaseIndex + 1,
      });
    }
  }

  private getGroupMeta(groupId: string): ConsensusGroupMeta | null {
    const group = this.db
      .prepare("SELECT * FROM delegation_groups WHERE id = ?")
      .get(groupId) as { id: string; task_id: string; parent_instance_id: string; policy: string } | null;

    if (!group) return null;

    try {
      const policy = JSON.parse(group.policy);
      if (policy.type !== "consensus") return null;

      return {
        groupId,
        taskId: group.task_id,
        phaseIndex: policy.phase_index,
        totalPhases: policy.total_phases,
        phaseName: policy.phase_name,
        entrypointAgentId: policy.entrypoint_agent_id,
        consensus: policy.consensus,
      };
    } catch {
      return null;
    }
  }

  private findGroupForReviewer(reviewerInstanceId: string): string | null {
    for (const [groupId, instanceId] of this.activeReviewerInstances) {
      if (instanceId === reviewerInstanceId) return groupId;
    }
    return null;
  }

  private getTerminalOutputSummary(instanceId: string, maxChars: number): string {
    const rows = this.db
      .prepare(
        `SELECT data FROM terminal_outputs
         WHERE agent_id = ? AND stream = 'stdout'
         ORDER BY sequence DESC
         LIMIT 100`,
      )
      .all(instanceId) as { data: string }[];

    const reversed = rows.reverse();
    let output = reversed.map((r) => r.data).join("");
    if (output.length > maxChars) {
      output = "..." + output.slice(output.length - maxChars);
    }
    return output;
  }

  private escalateConsensusFailed(taskId: string, groupId: string, failedCount: number, totalCount: number): void {
    try {
      const escalationId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, 'consensus_failed', ?, 'high')`,
        )
        .run(
          escalationId,
          "system",
          taskId,
          `Consensus phase failed: ${failedCount}/${totalCount} agents failed in group ${groupId}`,
        );
      eventBus.emit("escalation:created", {
        escalationId,
        agentId: "system",
        taskId,
        type: "consensus_failed",
        question: `${failedCount}/${totalCount} consensus agents failed`,
      });
    } catch (err) {
      logError(this.db, "consensus_escalation", { taskId, groupId }, err);
    }
  }

  private escalateReviewerFailed(taskId: string, groupId: string): void {
    try {
      const escalationId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, 'consensus_reviewer_failed', ?, 'high')`,
        )
        .run(
          escalationId,
          "system",
          taskId,
          `Consensus reviewer failed after retries for group ${groupId}. Manual review needed.`,
        );
      eventBus.emit("escalation:created", {
        escalationId,
        agentId: "system",
        taskId,
        type: "consensus_reviewer_failed",
        question: "Consensus reviewer failed after retries",
      });
    } catch (err) {
      logError(this.db, "consensus_reviewer_escalation", { taskId, groupId }, err);
    }
  }

  private escalateApplyFailed(taskId: string, groupId: string, error: unknown): void {
    try {
      const escalationId = crypto.randomUUID();
      const errMsg = error instanceof Error ? error.message : String(error);
      this.db
        .prepare(
          `INSERT INTO escalations (id, agent_id, task_id, type, question, severity)
           VALUES (?, ?, ?, 'consensus_apply_failed', ?, 'high')`,
        )
        .run(
          escalationId,
          "system",
          taskId,
          `Failed to apply consensus diff for group ${groupId}: ${errMsg}`,
        );
      eventBus.emit("escalation:created", {
        escalationId,
        agentId: "system",
        taskId,
        type: "consensus_apply_failed",
        question: `Failed to apply consensus diff: ${errMsg}`,
      });
    } catch (err) {
      logError(this.db, "consensus_apply_escalation", { taskId, groupId }, err);
    }
  }
}
