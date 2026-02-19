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

export interface TaskStateChangedEvent {
  taskId: string;
  previousStatus: string;
  newStatus: string;
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

export interface ConversationMessageEvent {
  conversationId: string;
  messageId: string;
  role: string;
  content: string;
  parts?: MessagePart[];
}

export type MessagePartKind = "text" | "thinking" | "tool_use" | "tool_result";

export interface MessagePart {
  kind: MessagePartKind;
  content: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
}

export interface ConversationStreamChunkEvent {
  conversationId: string;
  turnId: string;
  blockIndex: number;
  part: MessagePart;
}

export interface ConversationTurnStartedEvent {
  conversationId: string;
  turnId: string;
}

export interface ConversationCreatedEvent {
  conversationId: string;
}

export interface ConversationArchivedEvent {
  conversationId: string;
}

export interface ConversationBusyChangedEvent {
  conversationId: string;
  busy: boolean;
  /** Model that powers the chat agent, used as the indicator label. */
  model?: string;
}

export interface ConversationPermissionModeChangedEvent {
  conversationId: string;
  mode: "default" | "plan" | "bypassPermissions";
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
  "task:state_changed": [TaskStateChangedEvent];
  "artifact:created": [ArtifactCreatedEvent];
  "realtime:window_ready": [RealtimeWindowReadyEvent];
  "realtime:trigger_fired": [RealtimeTriggerFiredEvent];
  "realtime:session_state": [RealtimeSessionStateEvent];
  "realtime:timeline_updated": [RealtimeTimelineUpdatedEvent];
  "conversation:message": [ConversationMessageEvent];
  "conversation:stream_chunk": [ConversationStreamChunkEvent];
  "conversation:turn_started": [ConversationTurnStartedEvent];
  "conversation:created": [ConversationCreatedEvent];
  "conversation:archived": [ConversationArchivedEvent];
  "conversation:busy_changed": [ConversationBusyChangedEvent];
  "conversation:permission_mode_changed": [ConversationPermissionModeChangedEvent];
  "consensus:phase_advance": [ConsensusPhaseAdvanceEvent];
  "task:needs_review_changed": [TaskNeedsReviewChangedEvent];
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
