import type { Database } from "bun:sqlite";
import { hashApiKey } from "../../mcp/auth";

/** Insert a fresh API key into the test DB and return it with ready-made auth headers. */
export function createTestApiKey(db: Database): { key: string; headers: { Authorization: string } } {
  const key = `sk-${crypto.randomUUID().replace(/-/g, "")}`;
  db.prepare("INSERT INTO api_keys (id, name, key_hash) VALUES (?, ?, ?)")
    .run(crypto.randomUUID(), "test-key", hashApiKey(key));
  return { key, headers: { Authorization: `Bearer ${key}` } };
}
