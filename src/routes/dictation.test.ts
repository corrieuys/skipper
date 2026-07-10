import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "bun";
import { startServer } from "../server";
import { getDb, initializeDatabase, resetDb } from "../db/connection";
import { registerDictationRoutes } from "./dictation";
import { setStringSetting } from "../config/app-settings";
import { clearAgentTypeCache } from "../agents/types";
import { stripFillerMarkers } from "../realtime/transcription";
import {
  getDictationModelChoice,
  saveModelSetting,
  PROVIDER_ALLOWLIST,
  SETTING_DICTATION_AGENT_TYPE,
} from "../config/model-settings";

let server: Server<unknown>;
let baseUrl: string;

// isExperimental() reads process.argv, and the dictation routes gate on it per
// request — flip the flag around individual tests.
function setExperimental(on: boolean): void {
  const idx = process.argv.indexOf("--experimental");
  if (on && idx === -1) process.argv.push("--experimental");
  if (!on && idx !== -1) process.argv.splice(idx, 1);
}

beforeAll(() => {
  resetDb();
  const db = getDb(":memory:");
  initializeDatabase(db);
  registerDictationRoutes();
  server = startServer(0);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  setExperimental(false);
  server.stop(true);
  resetDb();
});

beforeEach(() => {
  setExperimental(true);
  clearAgentTypeCache();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe("stripFillerMarkers", () => {
  it("removes whisper filler markers and trims", () => {
    expect(stripFillerMarkers(" [pause] hello [SILENCE] world [blank_audio][music] ")).toBe("hello  world");
    expect(stripFillerMarkers("[music]")).toBe("");
    expect(stripFillerMarkers("plain text")).toBe("plain text");
  });
});

describe("dictation model setting", () => {
  it("defaults to claude-code haiku and honors the saved override", () => {
    const db = getDb();
    expect(getDictationModelChoice(db)).toEqual({ agent_type: "claude-code", model: "claude-haiku-4-5" });
    expect(saveModelSetting(db, "dictation", "claude-code", "claude-sonnet-4-6")).toBeNull();
    expect(getDictationModelChoice(db).model).toBe("claude-sonnet-4-6");
    // reset for other tests
    setStringSetting(db, SETTING_DICTATION_AGENT_TYPE, "");
    setStringSetting(db, "dictation_model", "");
  });

  it("provider allowlist offers all first-class providers", () => {
    expect([...PROVIDER_ALLOWLIST]).toEqual(["claude-code", "codex", "opencode", "oz"]);
  });
});

describe("POST /api/dictation/transcribe", () => {
  it("404s when experimental is off", async () => {
    setExperimental(false);
    const { status } = await post("/api/dictation/transcribe", { audio: "aGk=", format: "webm" });
    expect(status).toBe(404);
  });

  it("400s on missing audio", async () => {
    const { status, json } = await post("/api/dictation/transcribe", { format: "webm" });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("audio");
  });

  it("503s with the adapter reason when whisper is not running", async () => {
    // Default realtime config: provider local, endpoint empty → not configured.
    const { status, json } = await post("/api/dictation/transcribe", { audio: "aGk=", format: "webm" });
    expect(status).toBe(503);
    expect(String(json.error)).toContain("Whisper not running");
  });
});

describe("POST /api/dictation/cleanup", () => {
  it("404s when experimental is off", async () => {
    setExperimental(false);
    const { status } = await post("/api/dictation/cleanup", { text: "hello" });
    expect(status).toBe(404);
  });

  it("400s on missing text", async () => {
    const { status } = await post("/api/dictation/cleanup", {});
    expect(status).toBe(400);
  });

  it("falls back to the raw text when the rewriter provider is unavailable", async () => {
    // Point the rewriter at a provider that doesn't exist so the one-shot call
    // fails fast without spawning anything.
    setStringSetting(getDb(), SETTING_DICTATION_AGENT_TYPE, "no-such-provider");
    const { status, json } = await post("/api/dictation/cleanup", { text: "um so like fix the bug" });
    expect(status).toBe(200);
    expect(json.text).toBe("um so like fix the bug");
    expect(json.cleaned).toBe(false);
    setStringSetting(getDb(), SETTING_DICTATION_AGENT_TYPE, "");
  });
});
