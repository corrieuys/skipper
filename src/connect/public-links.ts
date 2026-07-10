import type { Database } from "bun:sqlite";
import { getStringSetting, SETTING_SKIPPER_CONNECT_KEY, SETTING_SKIPPER_CONNECT_URL } from "../config/app-settings";
import type { TaskArtifact } from "../orchestrator/artifact-manager";

/**
 * Instance global id, read from the connect key's JWT payload. No signature
 * check: the integrator is authoritative for auth and routes by the gid it
 * verifies itself; this value is only used to build URLs client-side.
 */
export function gidFromConnectKey(key: string): string | null {
  const segments = key.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf-8")) as { gid?: unknown };
    return typeof payload.gid === "string" && payload.gid ? payload.gid : null;
  } catch {
    return null;
  }
}

function getConnectHttpBaseAndGid(db: Database): { httpBase: string; gid: string } | null {
  const key = getStringSetting(db, SETTING_SKIPPER_CONNECT_KEY, "");
  const gid = key ? gidFromConnectKey(key) : null;
  if (!gid) return null;
  // No default remote: public links only exist once the operator configures a
  // Connect URL. Without one there is nowhere to serve them from.
  const wsUrl = getStringSetting(db, SETTING_SKIPPER_CONNECT_URL, "");
  if (!wsUrl) return null;
  const httpBase = wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/+$/, "");
  return { httpBase, gid };
}

export function getConnectPublicBase(db: Database): string | null {
  const base = getConnectHttpBaseAndGid(db);
  return base ? `${base.httpBase}/p/${encodeURIComponent(base.gid)}` : null;
}

/**
 * Public URL for a published artifact version, served by the connect
 * integrator which relays back to this instance over the authed WebSocket.
 * Null when connect is unconfigured (no key) or the artifact has no key.
 */
export function getPublicArtifactUrl(db: Database, artifact: Pick<TaskArtifact, "id" | "publish_key">): string | null {
  if (!artifact.publish_key) return null;
  const base = getConnectPublicBase(db);
  if (!base) return null;
  return `${base}/${artifact.id}?key=${encodeURIComponent(artifact.publish_key)}`;
}

/**
 * Public webhook trigger URL for a recurring task, served by the connect
 * integrator (POST /wh/:gid/:scheduledTaskId?key=...) which relays back to
 * this instance; the daemon validates the key and fires "Run Now". Null when
 * connect is unconfigured or the task's webhook trigger is disabled.
 */
export function getWebhookTriggerUrl(
  db: Database,
  scheduled: { id: string; webhook_key: string | null },
): string | null {
  if (!scheduled.webhook_key) return null;
  const base = getConnectHttpBaseAndGid(db);
  if (!base) return null;
  return `${base.httpBase}/wh/${encodeURIComponent(base.gid)}/${encodeURIComponent(scheduled.id)}?key=${encodeURIComponent(scheduled.webhook_key)}`;
}
