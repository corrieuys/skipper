import { EventEmitter } from "events";

export interface AgentOutputEvent {
  agentId: string;
  stream: "stdout" | "stderr";
  data: string;
  sequence: number;
}

export interface AgentExitEvent {
  agentId: string;
  code: number;
  isRespawn: boolean;
  hasDelegation: boolean;
  stderrSnippet: string;
}

export interface EscalationCreatedEvent {
  escalationId: string;
  agentId: string;
  taskId: string;
  type: string;
  question: string;
}

export interface EscalationResolvedEvent {
  escalationId: string;
  agentId: string;
  taskId: string;
  response: string;
}

export interface TaskNoteAddedEvent {
  noteId: string;
  taskId: string;
  agentId: string;
  content: string;
}

/** An agent posted an operator-facing message (see src/messages). */
export interface TaskMessagePostedEvent {
  messageId: string;
  taskId: string;
  agentId: string;
  content: string;
}

export interface TaskStateChangedEvent {
  taskId: string;
  previousStatus: string;
  newStatus: string;
}

export interface TaskCreatedEvent {
  taskId: string;
}

export interface TaskPhaseChangedEvent {
  taskId: string;
  previousPhase: number;
  newPhase: number;
  direction: "advance" | "regress";
}

export interface ArtifactPublishStateEvent {
  artifactId: string;
  taskId: string;
  name: string;
  version: number;
  /** ISO timestamp when published; null after unpublish. */
  publishedAt: string | null;
}

export interface AgentStateChangedEvent {
  agentId: string;
  previousState: string;
  newState: string;
}

export interface AgentStreamsDrainedEvent {
  agentId: string;
}

export interface AgentSignalEvent {
  agentId: string;
  signalType: string;
  content?: string;
  targetAgent?: string;
  targetInstanceId?: string;
  taskId?: string;
  targetPhase?: number;
  reason?: string;
}

export interface InstanceStateChangedEvent {
  instanceId: string;
  templateAgentId: string;
  taskId: string;
  parentInstanceId: string | null;
  rootInstanceId: string | null;
  status: string;
}

export interface DelegationGroupProgressEvent {
  groupId: string;
  taskId: string;
  parentInstanceId: string;
  settledCount: number;
  expectedCount: number;
  failedCount: number;
  status: string;
}

export interface ArtifactCreatedEvent {
  artifactId: string;
  taskId: string;
  name: string;
  version: number;
  kind: string;
}

export interface RealtimeWindowReadyEvent {
  windowId: string;
  taskId: string;
  artifactName: string;
  version: number;
  windowStartAt: string;
  windowEndAt: string;
}

export interface RealtimeTriggerFiredEvent {
  windowId: string;
  taskId: string;
  confidence: number;
  decision: string;
  delegationId?: string;
}

export interface RealtimeSessionStateEvent {
  taskId: string;
  state: "active" | "stopping" | "stopped";
}

export interface RealtimeTimelineUpdatedEvent {
  taskId: string;
  entryId: string;
  entryType: string;
}

// Cross-client single-writer recording lock changed. Fanned out to every client
// (web UI, iOS, connect consumers) so they enable/disable their Record control.
export interface RealtimeAudioLockEvent {
  taskId: string;
  locked: boolean;
  owner?: string;        // opaque source id, e.g. "web:<id>" / "connect:<id>"
  ownerLabel?: string;   // human label, e.g. "web" / "ios"
}

export interface ConsensusPhaseAdvanceEvent {
  taskId: string;
  entrypointAgentId: string;
  nextPhaseIndex: number;
}

export interface TaskNeedsReviewChangedEvent {
  taskId: string;
  needsReview: boolean;
  phaseName?: string;
  phaseIndex?: number;
}

/** A run of an active task finished (root called complete_task / last phase done). Task stays active. */
export interface TaskRunCompletedEvent {
  taskId: string;
  result: unknown | null;
}

/** A run of an active task hit an error. Task stays active and can be woken with new input. */
export interface TaskRunFailedEvent {
  taskId: string;
  error: string | null;
}

/** Input arrived for a task with no live root agent; the queue should wake it when a slot frees. */
export interface TaskWakeRequestedEvent {
  taskId: string;
}

export interface EventMap {
  "agent:output": [AgentOutputEvent];
  "agent:exit": [AgentExitEvent];
  "agent:streams_drained": [AgentStreamsDrainedEvent];
  "agent:signal": [AgentSignalEvent];
  "agent:state_changed": [AgentStateChangedEvent];
  "instance:state_changed": [InstanceStateChangedEvent];
  "delegation_group:progress": [DelegationGroupProgressEvent];
  "escalation:created": [EscalationCreatedEvent];
  "escalation:resolved": [EscalationResolvedEvent];
  "task:note_added": [TaskNoteAddedEvent];
  "task:message_posted": [TaskMessagePostedEvent];
  "task:state_changed": [TaskStateChangedEvent];
  "task:created": [TaskCreatedEvent];
  "task:phase_changed": [TaskPhaseChangedEvent];
  "artifact:created": [ArtifactCreatedEvent];
  "artifact:published": [ArtifactPublishStateEvent];
  "artifact:unpublished": [ArtifactPublishStateEvent];
  "realtime:window_ready": [RealtimeWindowReadyEvent];
  "realtime:trigger_fired": [RealtimeTriggerFiredEvent];
  "realtime:session_state": [RealtimeSessionStateEvent];
  "realtime:timeline_updated": [RealtimeTimelineUpdatedEvent];
  "realtime:audio_lock": [RealtimeAudioLockEvent];
  "consensus:phase_advance": [ConsensusPhaseAdvanceEvent];
  "task:needs_review_changed": [TaskNeedsReviewChangedEvent];
  "task:run_completed": [TaskRunCompletedEvent];
  "task:run_failed": [TaskRunFailedEvent];
  "task:wake_requested": [TaskWakeRequestedEvent];
}

export type EventName = keyof EventMap;

class EventBus extends EventEmitter {
  override emit<K extends EventName>(event: K, ...args: EventMap[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends EventName>(event: K, listener: (...args: EventMap[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends EventName>(event: K, listener: (...args: EventMap[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends EventName>(event: K, listener: (...args: EventMap[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const eventBus = new EventBus();
