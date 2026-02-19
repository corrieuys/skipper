import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export interface Message {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  type: string;
  content: string;
  taskId: string | null;
  createdAt: string;
}

export interface ParsedMessageSignal {
  type: string;
  toAgentName: string;
  content: string;
}

// Matches: [MSG:type to:AgentName] content
const MSG_SIGNAL_RE = /^\[MSG:(\w+)\s+to:([^\]]+)\]\s*([\s\S]*)$/;

export function parseMessageSignal(line: string): ParsedMessageSignal | null {
  const match = line.match(MSG_SIGNAL_RE);
  if (!match) return null;
  return {
    type: match[1],
    toAgentName: match[2].trim(),
    content: match[3],
  };
}

export function findAgentByName(db: Database, name: string): { id: string; name: string } | null {
  return db.prepare("SELECT id, name FROM agents WHERE name = ?").get(name) as { id: string; name: string } | null;
}

export function persistMessage(
  db: Database,
  params: {
    fromAgentId: string;
    toAgentId: string;
    type: string;
    content: string;
    taskId?: string | null;
  }
): Message {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO messages (id, from_agent_id, to_agent_id, type, content, task_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, params.fromAgentId, params.toAgentId, params.type, params.content, params.taskId ?? null);

  return db.prepare(
    `SELECT id,
            from_agent_id AS fromAgentId,
            to_agent_id   AS toAgentId,
            type,
            content,
            task_id       AS taskId,
            created_at    AS createdAt
     FROM messages WHERE id = ?`
  ).get(id) as Message;
}

export function routeAgentMessage(
  db: Database,
  params: {
    fromAgentId: string;
    toAgentName: string;
    type: string;
    content: string;
    taskId?: string | null;
  }
): { message: Message; toAgentId: string } | { error: string } {
  const recipient = findAgentByName(db, params.toAgentName);
  if (!recipient) {
    return { error: `Agent '${params.toAgentName}' not found` };
  }

  const message = persistMessage(db, {
    fromAgentId: params.fromAgentId,
    toAgentId: recipient.id,
    type: params.type,
    content: params.content,
    taskId: params.taskId,
  });

  return { message, toAgentId: recipient.id };
}

export function getMessagesForAgent(db: Database, agentId: string): Message[] {
  return db.prepare(
    `SELECT id,
            from_agent_id AS fromAgentId,
            to_agent_id   AS toAgentId,
            type,
            content,
            task_id       AS taskId,
            created_at    AS createdAt
     FROM messages
     WHERE to_agent_id = ? OR from_agent_id = ?
     ORDER BY created_at ASC`
  ).all(agentId, agentId) as Message[];
}
