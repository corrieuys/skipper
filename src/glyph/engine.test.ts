import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../db/connection";
import { eventBus } from "../events/bus";
import { GlyphEngine, glyphTopic, type GlyphModelCall, type GlyphModelReply } from "./engine";
import { loadGlyphScreen, saveGlyphScreen } from "./store";
import { EMPTY_GLYPH_CURSOR } from "../data/glyph";

let db: Database;
let pushed: Array<{ resource: string; id: string | null; data: unknown; topics: string[] }>;
let clients: Set<string>;
let calls: GlyphModelCall[];
let replies: Array<GlyphModelReply | null>;
let engine: GlyphEngine;

function setExperimental(on: boolean): void {
  const idx = process.argv.indexOf("--experimental");
  if (on && idx === -1) process.argv.push("--experimental");
  if (!on && idx !== -1) process.argv.splice(idx, 1);
}

const push = {
  broadcastJson(_event: string, resource: string, id: string | null, data: unknown, topics: string[]) {
    pushed.push({ resource, id, data, topics });
  },
  hasJsonClients(topics: string[]) {
    return topics.some((t) => clients.has(t));
  },
};

const runner = async (call: GlyphModelCall): Promise<GlyphModelReply | null> => {
  calls.push(call);
  const next = replies.shift();
  return next === undefined ? null : next;
};

const reply = (text: string, sessionId = "s1"): GlyphModelReply => ({ text, sessionId });
const frames = () => pushed.filter((p) => p.resource === "glyph").map((p) => p.data as { t: string; s: string; frame: string });

beforeEach(() => {
  setExperimental(true);
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO agents (id, name, type) VALUES ('ag1', 'Builder', 'claude-code')").run();
  db.prepare("INSERT INTO tasks (id, title, description, status) VALUES ('t1', 'Task', 'desc', 'active')").run();
  pushed = [];
  clients = new Set([glyphTopic("t1")]);
  calls = [];
  replies = [];
  engine = new GlyphEngine(db, push, { runner, debounceMs: 5 });
  engine.start();
});

afterEach(() => {
  engine.stop();
  db.close();
  setExperimental(false);
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("GlyphEngine", () => {
  it("open on an empty screen wakes, renders, and pushes the frame on the task topic", async () => {
    replies.push(reply('```glyph\nRENDER ra[cb[hc"Task"td"working"]]\n```'));
    const before = engine.open("t1");
    expect(before.frame).toBe("");
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionId).toBeNull();
    expect(calls[0]!.taskId).toBe("t1");
    expect(calls[0]!.prompt).toContain("== TOOLS ==");
    expect(calls[0]!.prompt).toContain("title: Task");
    expect(calls[0]!.prompt).toContain("desc");
    expect(calls[0]!.systemPrompt).toContain("glyph renderer");
    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]!.t).toBe("frame");
    expect(engine.status("t1").view).toBe('ra[cb[hc"Task"td"working"]]');
    expect(f[0]!.frame).toBe('ra[cb[hc"Task"td"working"]]');
    expect(pushed[0]!.topics).toEqual(["glyph:t1"]);
    expect(engine.status("t1")).toMatchObject({ frame: 'ra[cb[hc"Task"td"working"]]', state: "idle", calls: 1, hasSession: true });
    // Second open returns the frame without another call.
    expect(engine.open("t1").frame).toBe('ra[cb[hc"Task"td"working"]]');
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("a note event wakes with only the delta, resumes the session, and applies a patch", async () => {
    replies.push(reply('```glyph\nRENDER ra[cb[hc"Task"ld"nothing yet"]]\n```'));
    engine.open("t1");
    await tick();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'went with sqlite')").run();
    replies.push(reply('```glyph\nPATCH ~d"Storage: SQLite"\n```'));
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "went with sqlite" });
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sessionId).toBe("s1");
    expect(calls[1]!.prompt).toContain("went with sqlite");
    expect(calls[1]!.prompt).not.toContain("description:");
    expect(calls[1]!.prompt).toContain('ra[cb[hc"Task"ld"nothing yet"]]');
    const f = frames();
    expect(f[1]).toEqual({ t: "frame", s: 'ra[cb[hc"Task"ld"Storage: SQLite"]]', frame: 'ra[cb[hc"Task"ld"Storage: SQLite"]]' });
  });

  it("does not call the model when no overlay is open or the flag is off", async () => {
    clients.clear();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'x')").run();
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "x" });
    await tick();
    expect(calls).toHaveLength(0);
    setExperimental(false);
    expect(engine.open("t1").frame).toBe("");
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("drops a debounced wake when the overlay closes before the timer fires", async () => {
    replies.push(reply('```glyph\nRENDER ra[cb[hc"Task"]]\n```'));
    engine.open("t1");
    await tick();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'x')").run();
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "x" });
    clients.clear(); // overlay closed inside the debounce window
    await tick();
    expect(calls).toHaveLength(1);
    // Reopening picks the note up on the next wake.
    clients.add(glyphTopic("t1"));
    replies.push(reply("```glyph\nNOOP\n```"));
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "x" });
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("NEW NOTES");
  });

  it("retries up to four attempts with detailed feedback, then leaves the screen as it was", async () => {
    replies.push(reply('```glyph\nRENDER ra[cb[hc"Task"]]\n```'));
    engine.open("t1");
    await tick();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'x')").run();
    replies.push(
      reply("```glyph\nPATCH ~z\"nope\"\n```"),
      reply("```glyph\nPATCH -q\n```"),
      reply("I think the screen is fine."),
      reply("```glyph\nRENDER ra[cb[hc\"T\"\n```"),
    );
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "x" });
    await tick(60);
    expect(calls).toHaveLength(5);
    expect(calls[2]!.prompt).toContain("PREVIOUS COMMAND WAS REJECTED");
    expect(calls[2]!.prompt).toContain("Attempt 1 of 4: your PATCH was rejected");
    expect(calls[2]!.prompt).toContain("unknown id 'z'");
    expect(calls[2]!.prompt).toContain("Ids currently on screen: a b c");
    expect(calls[2]!.prompt).not.toContain("NEW NOTES");
    expect(calls[3]!.prompt).toContain("Attempt 2 of 4");
    expect(calls[4]!.prompt).toContain("Attempt 3 of 4: no command was found");
    expect(frames()).toHaveLength(1);
    expect(engine.status("t1").state).toBe("error");
    expect(engine.status("t1").error).toContain("expected");
    expect(engine.status("t1").frame).toBe('ra[cb[hc"Task"]]');
    // The delta was consumed by the session: a further wake with nothing new is skipped.
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "x" });
    await tick();
    expect(calls).toHaveLength(5);
  });

  it("keeps the cursor when the provider fails so the delta is re-sent", async () => {
    replies.push(reply('```glyph\nRENDER ra[cb[hc"Task"]]\n```'));
    engine.open("t1");
    await tick();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'important')").run();
    replies.push(null);
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "important" });
    await tick();
    expect(engine.status("t1").state).toBe("error");
    replies.push(reply("```glyph\nNOOP\n```"));
    eventBus.emit("task:message_posted", { messageId: "m", taskId: "t1", agentId: "ag1", content: "" });
    await tick();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.prompt).toContain("important");
    expect(engine.status("t1").state).toBe("idle");
  });

  it("rejects a one-way violation and feeds it back", async () => {
    replies.push(reply('```glyph\nRENDER ra[Bb>go"Go"]\n```'), reply('```glyph\nRENDER ra[tb"ok"]\n```'));
    engine.open("t1");
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("one-way");
    expect(engine.status("t1").frame).toBe('ra[tb"ok"]');
  });

  it("reset clears the screen and session, then renders from scratch", async () => {
    replies.push(reply('```glyph\nRENDER ra[tb"one"]\n```'));
    engine.open("t1");
    await tick();
    replies.push(reply('```glyph\nRENDER ra[tb"two"]\n```', "s2"));
    engine.reset("t1");
    await tick();
    const f = frames();
    expect(f.map((x) => x.frame)).toEqual(['ra[tb"one"]', "", 'ra[tb"two"]']);
    expect(calls[1]!.sessionId).toBeNull();
    expect(calls[1]!.prompt).toContain("description:");
  });

  it("forgets a deleted task", async () => {
    replies.push(reply('```glyph\nRENDER ra[tb"one"]\n```'));
    engine.open("t1");
    await tick();
    eventBus.emit("task:state_changed", { taskId: "t1", previousStatus: "active", newStatus: "deleted" });
    expect(engine.status("t1").frame).toBe("");
  });
});

describe("GlyphEngine web views", () => {
  it("resolves w sources for the browser, keeps the model's text, and rejects unknown ones with feedback", async () => {
    db.prepare("INSERT INTO task_artifacts (id, task_id, name, version, kind, body, storage, mime) VALUES ('a1', 't1', 'shot.png', 1, 'upload', '', 'file', 'image/png')").run();
    replies.push(
      reply('```glyph\nRENDER ra[wb"artifact:nope"]\n```'),
      reply('```glyph\nRENDER ra[wb*2"artifact:shot.png"cc[td"x"]]\n```'),
    );
    engine.open("t1");
    await tick(60);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("no artifact named 'nope'");
    expect(calls[1]!.prompt).toContain("Hint: A w node shows one of");
    const st = engine.status("t1");
    expect(st.frame).toBe('ra[wb*2"artifact:shot.png"cc[td"x"]]');
    expect(st.view).toBe('ra[wb*2"/api/artifacts/a1/file?glyph=image"cc[td"x"]]');
    const f = frames();
    expect(f).toHaveLength(1);
    expect(f[0]).toEqual({ t: "frame", s: st.view, frame: st.view });
    // A refresh op reaches the browser as a refresh list on the pushed frame.
    replies.push(reply("```glyph\nPATCH #b\n```"));
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'new screenshot')").run();
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "new screenshot" });
    await tick(60);
    expect(frames()[1]).toEqual({ t: "frame", s: st.view, frame: st.view, refresh: ["b"] });
  });
});

describe("GlyphEngine resume", () => {
  it("keeps each task's screen in memory and catches up on reopen without a call when nothing changed", async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t2', 'Other', 'active')").run();
    clients.add(glyphTopic("t2"));
    replies.push(reply('```glyph\nRENDER ra[tb"A"]\n```'));
    engine.open("t1");
    await tick();
    replies.push(reply('```glyph\nRENDER ra[tb"B"]\n```', "s2"));
    engine.open("t2");
    await tick();
    expect(calls).toHaveLength(2);
    // Overlay closed on t1, reopened: same screen, no model call.
    clients.delete(glyphTopic("t1"));
    clients.add(glyphTopic("t1"));
    expect(engine.open("t1").view).toBe('ra[tb"A"]');
    await tick();
    expect(calls).toHaveLength(2);
    expect(engine.status("t2").view).toBe('ra[tb"B"]');
  });

  it("a note that landed while the overlay was closed is rendered on reopen", async () => {
    replies.push(reply('```glyph\nRENDER ra[tb"A"]\n```'));
    engine.open("t1");
    await tick();
    clients.clear(); // overlay closed
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'missed while away')").run();
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "missed while away" });
    await tick();
    expect(calls).toHaveLength(1);
    clients.add(glyphTopic("t1"));
    replies.push(reply('```glyph\nPATCH ~b"A, updated"\n```'));
    expect(engine.open("t1").view).toBe('ra[tb"A"]');
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("missed while away");
    expect(engine.status("t1").view).toBe('ra[tb"A, updated"]');
  });
});

describe("GlyphEngine operator input", () => {
  it("wakes on a timeline update and feeds the operator's words as input, not as agent state", async () => {
    replies.push(reply('```glyph\nRENDER ra[tb"A"]\n```'));
    engine.open("t1");
    await tick();
    db.prepare("INSERT INTO realtime_timeline (id, task_id, entry_type, content) VALUES ('i1', 't1', 'transcript', 'can we ship thursday')").run();
    replies.push(reply("```glyph\nNOOP\n```"));
    eventBus.emit("realtime:timeline_updated", { taskId: "t1", entryId: "i1", entryType: "transcript" });
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("NEW OPERATOR INPUT");
    expect(calls[1]!.prompt).toContain("instructions FOR SOMEONE ELSE");
    expect(calls[1]!.prompt).toContain("operator (spoken): can we ship thursday");
    expect(calls[1]!.prompt).not.toContain("NEW NOTES");
  });
});

describe("GlyphEngine persistence", () => {
  it("a fresh engine on the same DB restores the screen, cursor and session, and the first wake says so", async () => {
    replies.push(reply('```glyph\nRENDER ra[cb[hc"Task"td"first"]]\n```', "sess-1"));
    engine.open("t1");
    await tick();
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n1', 't1', 'ag1', 'seen')").run();
    replies.push(reply("```glyph\nNOOP\n```", "sess-1"));
    eventBus.emit("task:note_added", { noteId: "n1", taskId: "t1", agentId: "ag1", content: "seen" });
    await tick();
    expect(calls).toHaveLength(2);
    engine.stop(); // simulates the daemon going away: in-memory state gone

    engine = new GlyphEngine(db, push, { runner, debounceMs: 5 });
    engine.start();
    const st = engine.open("t1");
    expect(st.view).toBe('ra[cb[hc"Task"td"first"]]');
    expect(st.hasSession).toBe(true);
    // Nothing landed since: the catch-up wake makes no call.
    await tick();
    expect(calls).toHaveLength(2);
    // Something lands: the wake carries only the delta, the restored note, and resumes the stored session.
    db.prepare("INSERT INTO task_notes (id, task_id, agent_id, content) VALUES ('n2', 't1', 'ag1', 'after restart')").run();
    replies.push(reply('```glyph\nPATCH ~d"second"\n```', "sess-1"));
    eventBus.emit("task:note_added", { noteId: "n2", taskId: "t1", agentId: "ag1", content: "after restart" });
    await tick();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.sessionId).toBe("sess-1");
    expect(calls[2]!.prompt).toContain("RESTORED AFTER A RESTART");
    expect(calls[2]!.prompt).toContain("after restart");
    expect(calls[2]!.prompt).not.toContain("seen");
    expect(engine.status("t1").view).toBe('ra[cb[hc"Task"td"second"]]');
    expect(loadGlyphScreen(db, "t1")!.frame).toBe('ra[cb[hc"Task"td"second"]]');
  });

  it("drops a stored session that no longer answers and retries once as a fresh session", async () => {
    saveGlyphScreen(db, "t1", { frame: 'ra[tb"kept"]', cursor: { ...EMPTY_GLYPH_CURSOR }, sessionId: "gone", calls: 7 });
    replies.push(null, reply("```glyph\nNOOP\n```", "new-sess"));
    engine.open("t1");
    await tick(60);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sessionId).toBe("gone");
    expect(calls[1]!.sessionId).toBeNull();
    expect(calls[1]!.prompt).toContain("description:");
    expect(calls[1]!.prompt).toContain("RESTORED AFTER A RESTART");
    expect(engine.status("t1")).toMatchObject({ view: 'ra[tb"kept"]', state: "idle", hasSession: true });
  });

  it("reset removes the stored screen", async () => {
    replies.push(reply('```glyph\nRENDER ra[tb"one"]\n```'));
    engine.open("t1");
    await tick();
    expect(loadGlyphScreen(db, "t1")).not.toBeNull();
    replies.push(reply('```glyph\nRENDER ra[tb"two"]\n```'));
    engine.reset("t1");
    await tick();
    expect(loadGlyphScreen(db, "t1")!.frame).toBe('ra[tb"two"]');
  });
});

describe("GlyphEngine active agents", () => {
  it("reports running/pending instances in status and pushes glyph:agents on instance changes", async () => {
    expect(engine.status("t1").activeAgents).toBe(0);
    db.prepare("INSERT INTO agent_instances (id, template_agent_id, task_id, status) VALUES ('i1', 'ag1', 't1', 'running')").run();
    db.prepare("INSERT INTO agent_instances (id, template_agent_id, task_id, status) VALUES ('i2', 'ag1', 't1', 'pending')").run();
    db.prepare("INSERT INTO agent_instances (id, template_agent_id, task_id, status) VALUES ('i3', 'ag1', 't1', 'completed')").run();
    expect(engine.status("t1").activeAgents).toBe(2);
    eventBus.emit("instance:state_changed", { instanceId: "i1", templateAgentId: "ag1", taskId: "t1", parentInstanceId: null, rootInstanceId: null, status: "running" });
    const agentsMsg = pushed.filter((p) => p.resource === "glyph:agents");
    expect(agentsMsg).toHaveLength(1);
    expect(agentsMsg[0]!.data).toEqual({ active: 2 });
    expect(agentsMsg[0]!.topics).toEqual(["glyph:t1"]);
    // No overlay open: no push.
    clients.clear();
    eventBus.emit("instance:state_changed", { instanceId: "i1", templateAgentId: "ag1", taskId: "t1", parentInstanceId: null, rootInstanceId: null, status: "completed" });
    expect(pushed.filter((p) => p.resource === "glyph:agents")).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});
