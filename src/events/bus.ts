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

export interface EventMap {
  "agent:output": [AgentOutputEvent];
  "agent:exit": [AgentExitEvent];
  "agent:state_changed": [AgentStateChangedEvent];
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
