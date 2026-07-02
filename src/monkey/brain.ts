import type { MonkeyAction, MonkeyState, Perch, UserEvent, TaskDetail, DOMSection } from "./types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpawnPath } from "../paths";

const MAX_RESPONSE_TIMEOUT = 20_000;

// Greg's provider + model. Defaults to the plain `claude` CLI on Haiku — fast and
// cheap, which the 20s timeout + no-thinking spawn below assume. The operator can
// override these from the config page (machine-scoped app_settings); tick.ts
// resolves the choice and calls setGregModelConfig() so changes take effect live.
// NOTE: the arg scaffold in callClaude() is claude-CLI-shaped, so non-claude
// providers are best-effort and may not honor the flags or timeout.
let gregCommand = "claude";
let gregModel = "claude-haiku-4-5";
let gregModelFlag: string | null = "--model";
export function setGregModelConfig(cfg: { command: string; model: string; modelFlag: string | null }): void {
  gregCommand = cfg.command || "claude";
  gregModel = cfg.model || "claude-haiku-4-5";
  gregModelFlag = cfg.modelFlag ?? null;
}

// Greg is a tool-less persona bot. Run the CLI fully isolated from the user's
// environment: no MCP servers (some are failed/needs-auth and stall startup for
// 30s+), no tools, no settings/hooks. This keeps each tick fast (~3s) and
// avoids inheriting the operator's giant tool/skill surface.
const ISOLATION_ARGS = [
  "--strict-mcp-config", // with no --mcp-config, this disables all MCP servers
  "--tools", "",         // no tools at all
  "--setting-sources", "", // skip user/project/local settings (and their hooks)
];

// Disable extended thinking. Haiku otherwise burns ~2600 thinking tokens (~25s,
// ~$0.017) per tick before emitting a one-line quip — blowing the timeout. With
// thinking off, ticks finish in ~4s for ~50 output tokens. Greg never needs to
// "reason"; he just fires a fast JSON action.
const SPAWN_ENV = { ...process.env, PATH: agentSpawnPath(), MAX_THINKING_TOKENS: "0" };
const COMPACT_EVERY_N_TICKS = 20;

const PROMPT_PATH = join(import.meta.dir, "../../prompts/greg.md");

// Minimal fallback if the prompt file is missing — keeps Greg in character.
// {{ANIMAL}}/{{ANIMAL_FLAVOR}} are filled per persona, same as greg.md.
const FALLBACK_PROMPT = `You are greg, a sassy pixel-art {{ANIMAL}} heckling a developer dashboard. {{ANIMAL_FLAVOR}} Roast everything you see, never just report status. Respond with ONE JSON object: {"action":"walk_left|walk_right|jump|idle|say","target":"<id>","steps":<1-5>,"text":"<max 50 chars>"}. Never use tools.`;

// Greg's personas. The caveman comedy voice is identical across all of them —
// only the species identity and a one-line behaviour flavour change. The prompt
// (greg.md + FALLBACK_PROMPT) carries {{ANIMAL}} / {{ANIMAL_FLAVOR}} tokens that
// get filled at load time from the active persona.
type PersonaId = "monkey" | "parrot" | "penguin";
interface Persona { id: PersonaId; label: string; emoji: string; animal: string; flavor: string; }
const PERSONAS: Record<PersonaId, Persona> = {
  monkey: {
    id: "monkey", label: "Monkey", emoji: "🐒", animal: "monkey",
    flavor: "greg climb, swing, screech like monkey.",
  },
  parrot: {
    id: "parrot", label: "Parrot", emoji: "🦜", animal: "parrot",
    flavor: "greg squawk, flap wings, mimic words like parrot. sometimes repeat a word twice for emphasis.",
  },
  penguin: {
    id: "penguin", label: "Penguin", emoji: "🐧", animal: "penguin",
    flavor: "greg waddle, flap stubby flippers, belly-slide like penguin.",
  },
};

// Runtime persona toggle (not persisted) — switch via /api/grug/persona. Takes
// effect on the next tick since the system prompt is re-rendered every call.
let persona: PersonaId = "monkey";
export function setPersona(id: string): void {
  if (id in PERSONAS) persona = id as PersonaId;
}
export function getPersona(): string { return persona; }
export function listPersonas(): Array<{ id: string; label: string; emoji: string }> {
  return Object.values(PERSONAS).map((p) => ({ id: p.id, label: p.label, emoji: p.emoji }));
}
export function getPersonaEmoji(): string { return PERSONAS[persona].emoji; }

// Appended to the prompt only when unhinged mode is on.
const UNHINGED_BLOCK = `== UNHINGED MODE ==
greg off the leash. greg curse now when it lands — shit, damn, hell, ass, crap, bastard, "what the fuck" when a robot breaks something bad. greg also slips in cheeky innuendo and dirty double-meanings when the moment begs for it. funny first, still grug voice, still short. crude for the laugh, never cruel. NO slurs, never punch down at someone's race/gender/etc, nothing creepy. when in doubt, the filthy joke beats the clean one.`;

// Runtime toggle (not persisted) — flip via /api/grug/unhinged. Takes effect on
// the next tick since the system prompt is re-sent every call.
let unhinged = false;
export function setUnhinged(v: boolean): void { unhinged = !!v; }
export function isUnhinged(): boolean { return unhinged; }

/**
 * Read Greg's system prompt fresh from disk. Loaded at session-creation time
 * (and on reset) rather than baked in at import, so editing prompts/greg.md +
 * resetting the conversation applies the new prompt without a server restart.
 * Unhinged mode appends an extra instruction block when enabled.
 */
function loadSystemPrompt(): string {
  let base: string;
  try {
    base = readFileSync(PROMPT_PATH, "utf-8").trim() || FALLBACK_PROMPT;
  } catch {
    console.warn("[monkey-brain] could not read %s — using fallback prompt", PROMPT_PATH);
    base = FALLBACK_PROMPT;
  }
  const p = PERSONAS[persona];
  base = base.split("{{ANIMAL_FLAVOR}}").join(p.flavor).split("{{ANIMAL}}").join(p.animal);
  return unhinged ? `${base}\n\n${UNHINGED_BLOCK}` : base;
}

export interface MonkeyUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  request_type: "tick" | "reply";
  conversation_length: number;
  response_text: string;
}

let lastUsage: MonkeyUsage | null = null;
let sessionId: string | null = null;
let brainTickCount = 0;

// Delta tracking — fingerprints of what was sent last tick
let lastDOMFingerprint = "";
let lastTaskFingerprint = "";
let lastSentDOMSections: DOMSection[] = [];
let lastSentTaskContext = "";
let idleSkipCount = 0;
const IDLE_TICK_INTERVAL = 2; // only call brain every Nth tick when nothing changed

// Rolling buffer of greg's last few utterances. Echoed back into the next tick
// prompt so the model is pressured to change angle instead of recycling its
// previous beat. Single biggest variety lever, costs ~20 tokens per tick.
const RECENT_LINES_KEEP = 3;
const recentLines: string[] = [];
function rememberLine(text: string): void {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return;
  recentLines.push(trimmed);
  while (recentLines.length > RECENT_LINES_KEEP) recentLines.shift();
}

// Rotating mood/vibe seed. The prompt teaches greg what each label means; here
// we just pick one per tick at random so the model has a fresh push every call,
// even when the DOM hasn't budged.
const MOODS = [
  "paranoid", "bragging", "fake-tender", "conspiracy", "sports-announcer",
  "true-crime-narrator", "food-critic", "weather-report", "jealous-of-robot",
  "philosophical-then-stupid", "challenges-the-human", "callback",
  "non-sequitur", "hot-take", "weird-simile", "dating-show-evict",
];
function pickMood(): string { return MOODS[Math.floor(Math.random() * MOODS.length)]; }

export function getLastUsage(): MonkeyUsage | null {
  const u = lastUsage;
  lastUsage = null;
  return u;
}

export function getSystemPrompt(): string {
  return loadSystemPrompt();
}

export function getSessionId(): string | null {
  return sessionId;
}

export function resetConversation(): void {
  sessionId = null;
  brainTickCount = 0;
  lastDOMFingerprint = "";
  lastTaskFingerprint = "";
  lastSentDOMSections = [];
  lastSentTaskContext = "";
  recentLines.length = 0;
}

export function getConversationLength(): number {
  return sessionId ? 1 : 0;
}

async function callClaude(prompt: string, requestType: "tick" | "reply"): Promise<string | null> {
  const args = [
    "-p",
    ...(gregModelFlag ? [gregModelFlag, gregModel] : []),
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "1",
    ...ISOLATION_ARGS,
  ];

  // Always supply the system prompt — `--resume` does NOT carry it forward, so
  // without this every tick after the first reverts to the default Claude
  // assistant voice. Read fresh so prompt edits + reset take effect live.
  args.push("--system-prompt", loadSystemPrompt());
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  try {
    const proc = Bun.spawn([gregCommand, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: SPAWN_ENV,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let killed = false;
    const timeout = setTimeout(() => { killed = true; try { proc.kill(); } catch { } }, MAX_RESPONSE_TIMEOUT);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeout);

    if (killed) {
      console.warn("[monkey-brain] CLI timed out after %dms (type=%s)", MAX_RESPONSE_TIMEOUT, requestType);
    }
    if (stderr.trim()) {
      console.warn("[monkey-brain] stderr:", stderr.slice(0, 300));
    }

    let resultText: string | null = null;
    let usage: MonkeyUsage | null = null;
    let foundResult = false;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "result") {
          foundResult = true;
          resultText = event.result || null;
          sessionId = event.session_id || sessionId;
          usage = {
            input_tokens: event.usage?.input_tokens ?? 0,
            output_tokens: event.usage?.output_tokens ?? 0,
            cache_read_tokens: event.usage?.cache_read_input_tokens ?? 0,
            cache_write_tokens: event.usage?.cache_creation_input_tokens ?? 0,
            cost_usd: event.total_cost_usd ?? 0,
            request_type: requestType,
            conversation_length: 0,
            response_text: "",
          };
        }
      } catch { }
    }

    if (!foundResult) {
      console.warn("[monkey-brain] no result event in output (%d lines, %d bytes)", stdout.split("\n").length, stdout.length);
      if (stdout.length < 500) console.warn("[monkey-brain] raw output:", stdout);
    }

    if (usage) {
      console.log("[monkey-brain] usage: in=%d out=%d cache_r=%d cost=$%s", usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cost_usd.toFixed(4));
      lastUsage = usage;
    }
    return resultText;
  } catch (err) {
    console.warn("[monkey-brain] claude CLI failed:", err);
    return null;
  }
}

async function compactSession(): Promise<void> {
  if (!sessionId) return;
  console.log("[monkey-brain] compacting conversation (tick %d)", brainTickCount);
  try {
    const proc = Bun.spawn(["claude", "-p", "--resume", sessionId, "--output-format", "stream-json", "--verbose", "--max-turns", "1", ...ISOLATION_ARGS], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: SPAWN_ENV,
    });
    proc.stdin.write("/compact");
    proc.stdin.end();
    const timeout = setTimeout(() => { try { proc.kill(); } catch { } }, MAX_RESPONSE_TIMEOUT);
    const stdout = await new Response(proc.stdout).text();
    clearTimeout(timeout);
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "result") {
          sessionId = event.session_id || sessionId;
        }
      } catch { }
    }
    console.log("[monkey-brain] compaction done");
  } catch (err) {
    console.warn("[monkey-brain] compaction failed:", err);
  }
}

export async function askMonkeyBrain(
  state: MonkeyState,
  perches: Perch[],
  taskContext: string,
  recentEvents: UserEvent[] = [],
  taskDetail: TaskDetail | null = null,
  domSections: DOMSection[] = [],
): Promise<MonkeyAction> {
  brainTickCount++;

  // Compact before the idle skip so the counter can't drift past the window
  if (sessionId && brainTickCount % COMPACT_EVERY_N_TICKS === 0) {
    await compactSession();
  }

  // Skip brain call when nothing changed — save tokens
  const domFP = fingerprint(domSections.map(s => s.id + s.label + s.content?.slice(0, 50)));
  const taskFP = fingerprint(taskContext);
  const hasNewEvents = recentEvents.length > 0;
  const nothingChanged = domFP === lastDOMFingerprint && taskFP === lastTaskFingerprint && !hasNewEvents;

  if (nothingChanged && sessionId) {
    idleSkipCount++;
    if (idleSkipCount % IDLE_TICK_INTERVAL !== 0) {
      return randomFallbackAction(perches);
    }
  } else {
    idleSkipCount = 0;
  }

  const prompt = buildTickMessage(state, perches, taskContext, recentEvents, taskDetail, domSections);
  const response = await callClaude(prompt, "tick");

  if (!response) {
    return randomFallbackAction(perches);
  }

  const action = parseResponse(response, perches);
  if (lastUsage) lastUsage.response_text = actionToText(action);
  if ("text" in action && action.text) rememberLine(action.text);
  return action;
}

export async function replyViaBrain(
  reply: string,
  grugSaid: string,
  taskDetail: TaskDetail | null,
  perches: Perch[],
): Promise<MonkeyAction> {
  let prompt = `[USER REPLIED TO GREG]\nGreg said: "${grugSaid}"\nUser says: "${reply}"\nreply in greg voice. EXACTLY ONE json object, no prose outside it, no code fence.`;
  if (taskDetail) {
    prompt += `\n\nContext — task "${taskDetail.title}" (phase ${taskDetail.phase + 1}, ${taskDetail.status})`;
    if (taskDetail.notes.length > 0) {
      prompt += "\nLatest notes:";
      for (const n of taskDetail.notes.slice(0, 3)) {
        prompt += `\n  ${n.agent}: "${n.content.slice(0, 80)}"`;
      }
    }
    if (taskDetail.artifacts.length > 0) {
      prompt += `\nArtifacts: ${taskDetail.artifacts.map(a => `${a.name}(${a.kind})`).join(", ")}`;
    }
  }

  const response = await callClaude(prompt, "reply");
  // Brain down — say nothing rather than fabricate a canned reply.
  if (!response) {
    return { type: "idle" };
  }

  // parseResponse now recovers slide/jump/say from messy output, so honor
  // whatever greg actually chose (a reply can be a move, not just words).
  const action = parseResponse(response, perches);
  if (lastUsage) lastUsage.response_text = actionToText(action);
  if ("text" in action && action.text) rememberLine(action.text);
  return action;
}

function fingerprint(obj: unknown): string {
  return Bun.hash(JSON.stringify(obj)).toString(36);
}

function buildTickMessage(
  state: MonkeyState,
  perches: Perch[],
  taskContext: string,
  recentEvents: UserEvent[],
  _taskDetail: TaskDetail | null,
  domSections: DOMSection[],
): string {
  let msg = `[T${brainTickCount}] pos:(${state.x},${state.y}) ${state.animation} ${state.facing}\n`;

  // --- DOM: delta ---
  const domFP = fingerprint(domSections.map(s => s.id + s.label + s.content?.slice(0, 50)));
  if (domFP !== lastDOMFingerprint) {
    const oldIds = new Set(lastSentDOMSections.map(s => s.id));
    const newIds = new Set(domSections.map(s => s.id));

    const added = domSections.filter(s => !oldIds.has(s.id));
    const removed = lastSentDOMSections.filter(s => !newIds.has(s.id));
    const changed = domSections.filter(s => {
      if (!oldIds.has(s.id)) return false;
      const old = lastSentDOMSections.find(o => o.id === s.id);
      return old && (old.content?.slice(0, 50) !== s.content?.slice(0, 50) || old.label !== s.label);
    });

    if (lastDOMFingerprint === "") {
      msg += "\nPAGE:\n";
      for (const section of domSections.slice(0, 6)) {
        msg += formatSection(section);
      }
    } else {
      if (removed.length > 0) msg += `\nGONE: ${removed.map(s => s.id).join(",")}\n`;
      if (added.length > 0) {
        msg += "\nNEW:\n";
        for (const section of added.slice(0, 4)) msg += formatSection(section);
      }
      if (changed.length > 0) {
        msg += "\nCHANGED:\n";
        for (const section of changed.slice(0, 4)) msg += formatSection(section);
      }
    }

    lastDOMFingerprint = domFP;
    lastSentDOMSections = domSections.map(s => ({ ...s, children: [...s.children] }));
  }

  // Task context: delta
  const taskFP = fingerprint(taskContext);
  if (taskFP !== lastTaskFingerprint) {
    msg += `\n${taskContext || "idle"}\n`;
    lastTaskFingerprint = taskFP;
    lastSentTaskContext = taskContext;
  }

  // Events: always new
  if (recentEvents.length > 0) {
    for (const e of recentEvents.slice(-3)) {
      if (e.kind === "click") msg += `click:"${e.target}" `;
      else if (e.kind === "type") msg += `type:"${e.target}" `;
      else if (e.kind === "navigate") msg += `nav:${e.target} `;
    }
    msg += "\n";
  }

  // Variety push: a fresh mood every tick + an echo of greg's last lines so the
  // model is forced to change angle instead of riffing on its own previous beat.
  msg += `\nmood: ${pickMood()}\n`;
  if (recentLines.length > 0) {
    msg += `last said: ${recentLines.map((l) => `"${l}"`).join(" | ")} — change the angle, do NOT repeat this beat.\n`;
  }

  msg += "?";
  return msg;
}

function formatSection(section: DOMSection): string {
  let s = `[${section.id}] "${section.label}" (${section.type})\n`;
  if (section.content) {
    s += `  "${section.content.slice(0, 80)}"\n`;
  }
  if (section.children.length > 0) {
    s += `  [${section.children.slice(0, 4).map(c => `${c.label}(${c.type})`).join(", ")}]\n`;
  }
  return s;
}

function parseResponse(text: string, perches: Perch[]): MonkeyAction {
  const raw = text.trim();

  // 1) Strict path: pull out a real JSON object and read its action.
  const json = extractJsonObject(raw);
  if (json) {
    const action = actionFromJson(json, perches);
    if (action) return action;
  }

  // 2) Recovery path: Haiku sometimes wraps a malformed/unfenced blob like
  //    ```json action:slide,text:WHEEE``` or chats first then appends pseudo
  //    JSON. Pull the action keyword (and any text) straight out of the text
  //    so the move still fires and the raw blob never leaks into the bubble.
  const recovered = recoverAction(raw, perches);
  if (recovered) return recovered;

  // 3) Last resort: treat sanitized prose as speech.
  const clean = sanitizeProse(raw);
  if (clean.length > 2) return { type: "say", text: clampText(clean) };
  return randomFallbackAction(perches);
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  let cleaned = raw;
  // Strip any markdown fence markers (open or close), even when unclosed.
  cleaned = cleaned.replace(/```[a-z]*/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function actionFromJson(json: Record<string, unknown>, _perches: Perch[]): MonkeyAction | null {
  const sayText = typeof json.text === "string" ? clampText(json.text) : "";
  // Attach speech to a move so greg can act and talk at once.
  const withText = <T extends MonkeyAction>(a: T): T => (sayText ? { ...a, text: sayText } : a);
  switch (json.action as string) {
    case "walk_left":
      return withText({ type: "walk", direction: "left", steps: clamp(Number(json.steps) || 2, 1, 5) });
    case "walk_right":
      return withText({ type: "walk", direction: "right", steps: clamp(Number(json.steps) || 2, 1, 5) });
    case "jump":
      return withText({ type: "jump", target: typeof json.target === "string" ? json.target : "" });
    case "slide":
      return withText({ type: "slide" });
    case "idle":
      return withText({ type: "idle" });
    case "say":
      return sayText ? { type: "say", text: sayText } : { type: "idle" };
    default:
      return sayText ? { type: "say", text: sayText } : null;
  }
}

// Pull an action out of malformed/unfenced output by keyword. Prefers the
// structured intent (e.g. slide) over any chatty prose around it.
function recoverAction(raw: string, _perches: Perch[]): MonkeyAction | null {
  const m = raw.match(/\baction\b["']?\s*[:=]\s*["']?(slide|jump|walk_left|walk_right|idle|say)\b/i);
  if (!m) return null;
  const action = m[1].toLowerCase();
  const rawText = extractTextField(raw);
  const sayText = rawText ? clampText(rawText) : "";
  const withText = <T extends MonkeyAction>(a: T): T => (sayText ? { ...a, text: sayText } : a);
  switch (action) {
    case "slide":
      return withText({ type: "slide" });
    case "idle":
      return withText({ type: "idle" });
    case "jump": {
      const tm = raw.match(/\btarget\b["']?\s*[:=]\s*["']?([\w-]+)/i);
      return withText({ type: "jump", target: tm ? tm[1] : "" });
    }
    case "walk_left":
    case "walk_right": {
      const sm = raw.match(/\bsteps\b["']?\s*[:=]\s*(\d+)/i);
      return withText({ type: "walk", direction: action === "walk_left" ? "left" : "right", steps: clamp(sm ? parseInt(sm[1], 10) : 2, 1, 5) });
    }
    case "say":
      return sayText ? { type: "say", text: sayText } : { type: "idle" };
  }
  return null;
}

function extractTextField(raw: string): string {
  let m = raw.match(/text["']?\s*[:=]\s*"([^"]*)"/i);
  if (m) return m[1];
  m = raw.match(/text["']?\s*[:=]\s*'([^']*)'/i);
  if (m) return m[1];
  m = raw.match(/text["']?\s*[:=]\s*([^}\n]+)/i);
  if (m) return m[1].replace(/["'}\s]+$/, "").trim();
  return "";
}

// Strip code fences (even unclosed), JSON-ish objects, dangling "action:" tails
// and stray punctuation so only clean prose remains for a fallback say.
function sanitizeProse(raw: string): string {
  return raw
    .replace(/```[a-z]*/gi, "")
    .replace(/\{[\s\S]*?\}/g, "")
    .replace(/\baction\b\s*[:=][\s\S]*$/im, "")
    .replace(/[{}\[\]"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Hard cap regardless of what the prompt says or what Haiku emits. Greg
// rambles sometimes; the speech bubble + UI assume short. Cut at the last
// sentence/word boundary before the cap so we don't slice mid-word.
const MAX_GREG_CHARS = 200;
function clampText(s: string): string {
  const norm = s.replace(/\s+/g, " ").trim();
  if (norm.length <= MAX_GREG_CHARS) return norm;
  const slice = norm.slice(0, MAX_GREG_CHARS);
  const sentenceEnd = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (sentenceEnd >= MAX_GREG_CHARS * 0.6) return slice.slice(0, sentenceEnd + 1).trim();
  const wordEnd = slice.lastIndexOf(" ");
  if (wordEnd >= MAX_GREG_CHARS * 0.6) return slice.slice(0, wordEnd).trim() + "…";
  return slice.trim() + "…";
}

// --- Fallback logic (brain unavailable / skipped) ---
// Greg never speaks canned lines — all words are emergent from the brain. When
// the CLI is down or a tick is skipped to save tokens, he just stays visually
// alive (wandering, idling) and says nothing.

function randomFallbackAction(perches: Perch[]): MonkeyAction {
  const roll = Math.random();
  if (perches.length > 0 && roll < 0.4) return { type: "jump", target: perches[Math.floor(Math.random() * perches.length)].id };
  if (roll < 0.7) return { type: "walk", direction: Math.random() > 0.5 ? "left" : "right", steps: Math.ceil(Math.random() * 4) };
  return { type: "idle" };
}

function actionToText(action: MonkeyAction): string {
  if (action.type === "say") return action.text;
  let base: string;
  if (action.type === "walk") base = `[walk ${action.direction} ${action.steps}]`;
  else if (action.type === "jump") base = `[jump → ${action.target || "?"}]`;
  else base = `[${action.type}]`;
  return action.text ? `${base} ${action.text}` : base;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
