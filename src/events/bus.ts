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
