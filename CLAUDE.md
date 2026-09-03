# Skipper

AI agent orchestrator. Spawn external CLI agents (claude-code, codex, opencode, grok). Route stdout signals via event bus. Tick-loop daemon coords multi-agent tasks. Real-time tasks support audio/text + transcription.

## Run

```sh
bun run index.ts                  # server, default port 5005 (command-center UI; see src/html/CLAUDE.md)
bun run test                      # tests
bun test <file>                   # single
bun run typecheck:cleanup         # dead code sweep
```

Dev: no build, Bun runs TS direct.

`typecheck:cleanup` baseline: ~360 errors, all `noUncheckedIndexedAccess`
nullability noise (TS2345/TS18048/TS2532/TS2339/TS18046/TS2322) in route/HTML
glue — known-benign, deliberately unfixed. Investigate only NEW error codes or
count jumps; unused-code errors (TS6133/6196/6138) should stay at zero.

## Package (standalone binary)

```sh
bun run build                     # cross-compile dist/skipper-{macos-arm64,linux-x64,linux-arm64}
bun run build linux-x64           # subset
bun run gen:assets                # regen embedded-asset manifest (after adding/removing assets)
bun run release                   # build all + SHA256SUMS + print manual publish recipe
```

`bun build --compile` bakes the Bun runtime + all assets into one file. Because a
compiled binary has no source tree, every file read at runtime (prompts, config
seeds, `src/html/public/*`, `src/db/*.sql`) must be an **embedded asset**, not an
`import.meta.dir`-relative `readFileSync`. See [src/assets.ts](src/assets.ts) +
[scripts/gen-assets.ts](scripts/gen-assets.ts). Add a new runtime-read file →
it must fall under a `gen-assets.ts` embed rule (`prompts/`, `config/`, `public/`,
`db/*.sql`) or the binary throws ENOENT on `/$bunfs/...`.

Mutable state lives in the data dir (`~/.skipper`, or `SKIPPER_DATA_DIR` /
`XDG_DATA_HOME`), never the binary: runtime DB, `greg.db`, and the config working
copy (seeded from embedded defaults on first run — see `ensureConfigSeeded`).
Whisper transcription needs a separately-built `vendor/whisper.cpp` and is not in
the binary (opt-in, fails gracefully if absent).

## CLI

Binary entry is [bin/cli.ts](bin/cli.ts) (npm shim: `bin/skipper.js`). Subcommands:
`start` (spawn detached, pid + log in data dir; waits for `/health` then opens the
UI in the default browser — `--no-open` skips), `stop` (SIGTERM recorded pid,
SIGKILL fallback), `restart`, `status` (pid + `/health`), `logs [-f]`, `serve`
(foreground — what `start` execs), `update` (self-replace from latest GitHub
release), `--version`.

## Release + distribute (manual)

Binaries ship via **GitHub Releases** (`corrieuys/skipper`), not npm.

**Automated (default):** push a version tag and CI does the rest —
[.github/workflows/release.yml](.github/workflows/release.yml) builds all three
targets on one Linux runner (Bun cross-compiles macOS too), writes
`SHA256SUMS`, and `gh release create`s the release with assets + generated notes.

```sh
git tag v0.2.0
git push origin v0.2.0
```

The **git tag is the single source of version truth**: the workflow derives
`SKIPPER_VERSION` from the tag (`v0.2.0` → `0.2.0`) and `build-binary.ts` bakes
it into the binary, so `skipper --version` matches the release tag and
`skipper update` compares correctly. `package.json`'s version is only the
local/dev fallback — bumping it is optional/cosmetic.

**Manual fallback (local):** [scripts/release.ts](scripts/release.ts)
(`bun run release`) builds every target + `dist/SHA256SUMS` and prints the exact
`git tag` + `gh release create` commands — it makes no git/gh writes itself.

Once a release is published, anyone can:
- install: `curl -fsSL https://letskipper.work/install.sh | bash` (the install script picks the OS/arch asset → `~/.local/bin/skipper`)
- update: `skipper update` (checks the releases API, downloads the matching asset, atomic self-swap).

The install script itself is **not** in this repo — it lives in the marketing
site and is served from `letskipper.work/install.sh` (source:
`personal/skipper-home/public/install.sh`). It downloads binaries from this
repo's GitHub Releases.

**Beta / prerelease channel.** Tag with a semver prerelease suffix
(`v0.2.0-beta.1`, `-rc.1`) → the workflow marks the GitHub Release
`--prerelease`, which keeps it off the `latest` pointer, so stable installs and
`skipper update` skip it automatically. Opt in explicitly:
- install newest incl. prereleases: `SKIPPER_CHANNEL=beta curl -fsSL https://letskipper.work/install.sh | bash`
- install an exact release: `SKIPPER_VERSION=v0.2.0-beta.1 curl -fsSL https://letskipper.work/install.sh | bash`
- update onto the beta channel: `skipper update --beta` (lists `/releases`, takes the newest incl. prereleases).

## Entry

- `index.ts` — boot DB, build `ManagerDaemon`, register routes, start Bun server, SIGINT/SIGTERM shutdown. Reached via `bin/cli.ts serve`.
- `src/server.ts` — tiny router. `addRoute()`. static served from embedded `public/*` assets (uploaded wallpapers from the data dir)
- `src/assets.ts` — embedded-asset access layer (`assetTextSync`, `assetFile`, `listAssets`, `isCompiledBinary`)

## Env

| var | default | use |
|---|---|---|
| `PORT` | 5005 | HTTP port |
| `SKIPPER_HOST` | 127.0.0.1 | bind address (loopback only by default — most of the HTTP surface has no auth; `--host`/`SKIPPER_HOST` to expose deliberately) |
| `SKIPPER_DATA_DIR` | `~/.skipper` | writable state (DB, greg.db, config copy, pid/log) |
| `SKIPPER_RUNTIME_DB_PATH` | `<data dir>/skipper-runtime.db` | runtime DB file |
| `SKIPPER_CONFIG_DIR` | `<data dir>/config` (binary) · `./config` (dev) | config snapshots |
| `SKIPPER_CONTEXT_COMPACT_THRESHOLD` | 400000 | input tokens before compact |
| `SKIPPER_HTTP_LOG` | (unset) | `all` = log every HTTP request; default skips high-frequency UI polls (still logs errors + slow) |
| `SKIPPER_LOG_MAX_BYTES` | 26214400 (25 MB) | size cap for `~/.skipper/skipper.log` (the daemon's stdout/stderr file); the tick loop snapshots it to `skipper.log.old` + truncates when exceeded |

## Map — where to look

| concern | dir |
|---|---|
| agent process spawn/parse/resume | [src/agents/CLAUDE.md](src/agents/CLAUDE.md) |
| custom agents (in-process, own harness + tools) | [src/custom-agents/CLAUDE.md](src/custom-agents/CLAUDE.md) |
| single agents (standalone agent runs a task alone, projected as a team-of-one) | [src/single-agents/CLAUDE.md](src/single-agents/CLAUDE.md) |
| custom tools (operator-defined JS tools) | [src/custom-tools/CLAUDE.md](src/custom-tools/CLAUDE.md) |
| tick loop, phase, delegation, recovery, health, artifacts, realtime session | [src/orchestrator/CLAUDE.md](src/orchestrator/CLAUDE.md) |
| DB lifecycle, schemas, migrations | [src/db/CLAUDE.md](src/db/CLAUDE.md) |
| JSON config store, feature flags, app settings | [src/config/CLAUDE.md](src/config/CLAUDE.md) |
| HTTP route handlers | [src/routes/CLAUDE.md](src/routes/CLAUDE.md) |
| server-rendered HTML (pages, panels, fragments) | [src/html/CLAUDE.md](src/html/CLAUDE.md) |
| terminal dashboard TUI (`skipper dashboard`, attaches to a running daemon) | [src/tui/CLAUDE.md](src/tui/CLAUDE.md) |
| event bus | [src/events/CLAUDE.md](src/events/CLAUDE.md) |
| WS push to UI | [src/ws/CLAUDE.md](src/ws/CLAUDE.md) |
| task CRUD + lifecycle | [src/tasks/CLAUDE.md](src/tasks/CLAUDE.md) |
| teams + phases + membership | [src/teams/CLAUDE.md](src/teams/CLAUDE.md) |
| escalations | [src/escalations/CLAUDE.md](src/escalations/CLAUDE.md) |
| operator messages (agent → human progress updates, experimental) | [src/messages/CLAUDE.md](src/messages/CLAUDE.md) |
| realtime audio/transcribe | [src/realtime/CLAUDE.md](src/realtime/CLAUDE.md) |
| whisper.cpp local server | [src/whisper/CLAUDE.md](src/whisper/CLAUDE.md) |
| MCP server (typed tools alt to stdout signals) | [src/mcp/CLAUDE.md](src/mcp/CLAUDE.md) |
| slack app integration (post as app via bot token; inbound slash commands via Socket Mode) | [src/slack/CLAUDE.md](src/slack/CLAUDE.md) |
| user hooks (task/escalation events → shell) | [src/hooks/CLAUDE.md](src/hooks/CLAUDE.md) |
| desktop notification sounds | [src/notifications/CLAUDE.md](src/notifications/CLAUDE.md) |
| greg/grug heckler bot | [src/monkey/CLAUDE.md](src/monkey/CLAUDE.md) |
| shared wire DTO types (all output surfaces) | [src/contracts/CLAUDE.md](src/contracts/CLAUDE.md) |
| shared read queries (HTML + JSON + WS) | [src/data/CLAUDE.md](src/data/CLAUDE.md) |
| global cross-task shared key/value store | [src/global-store/CLAUDE.md](src/global-store/CLAUDE.md) |
| skipper connect (outbound WS to integrator, remote control + public artifact links) | [src/connect/CLAUDE.md](src/connect/CLAUDE.md) |
| external config file readers (MCP, skills) | [src/config-readers/CLAUDE.md](src/config-readers/CLAUDE.md) |
| prompt templates loaded at runtime | [prompts/CLAUDE.md](prompts/CLAUDE.md) |
| JSON config snapshots | [config/CLAUDE.md](config/CLAUDE.md) |
| dev scripts | [scripts/CLAUDE.md](scripts/CLAUDE.md) |

## Agent → orchestrator protocol

Two paths feed `agent:signal` on the bus:

**1. MCP tools** (primary). Agents call typed tools on the daemon MCP server at `/mcp` (Bearer = `runtimeId`). Definitions in `src/mcp/tools.ts`. Includes:
`delegate`, `delegate_batch`, `complete_phase`, `regress_phase`, `complete_task`, `escalate`, `create_note`, `create_artifact`, `create_file_artifact` (attach a file the agent generated on disk as a file artifact; timeline card attributed to the agent, never fed back as input), `get_artifact`, `list_artifacts`, `set_global_value`, `get_global_value`, `query_global_store`, `delete_global_value`, plus `send_message`, plus the recurring-task pair `list_recurring_tasks`/`run_recurring_task`. Phase-lifecycle tools (`complete_phase`, `regress_phase`, `complete_task`) and the recurring-task pair (`list_recurring_tasks`, `run_recurring_task` — kick off another approved recurring task's run, optional one-off `prompt`; carries the calling task's Slack thread to the new run by default so its Slack output continues there, opt out with `continue_slack_thread:false`) are root-Skipper only — delegated children get a refusal message (recurring pair simply isn't registered for them). Global-store tools (`set_global_value`/`get_global_value`/`query_global_store`/`delete_global_value`) write a cross-task shared table — agents use them only when a task/phase/template explicitly instructs it. Slack tools (`slack_send_message`/`slack_send_dm`/`slack_read_channel`, experimental) post/read as the Skipper Slack app; registered on a session only when a bot token is configured AND the task's team has Slack enabled (see [src/slack/CLAUDE.md](src/slack/CLAUDE.md)).

**2. Stdout marker parse** (legacy, narrow). `src/agents/manager.ts:SIGNAL_PATTERNS` scans each line. Surviving markers:

```
[MSG:<type> to:<agent>] <content>     ← agent ↔ agent message
[DELEGATE_COMPLETE] <result>           ← terminal sentinel printed by delegated child
```

JSON-mode agents (claude-code, codex) also scan assistant text via `detectSignalsInText()` for the same surviving set.

Deprecated stdout markers (now MCP-only): `[DELEGATE]`, `[DELEGATE_BATCH]`, `[ESCALATE]`, `[NOTE]`, `[PHASE_COMPLETE]`, `[PHASE_REGRESSION N]`, `[TASK_COMPLETE]`, `[ARTIFACT]…[END_ARTIFACT]`, `[ARTIFACT_LIST]`, `[ARTIFACT_GET]`. If you see one in stdout it is silently ignored.

## Task lifecycle (unified model)

```
draft → active → settled
```

Stored status is only those three. Everything else is derived runtime state
(`src/tasks/status.ts:deriveDisplayStatus`): an active task is `queued`
(wake pending / first start), `working` (live agents or open delegations),
`idle` (at rest, wake with input), `paused` (flag), `review`, or `blocked`
(open escalation). Archive is the only terminal transition and is always
user- or policy-initiated (`settleTask`); `reviveTask` reverses it.

**Autopilot** (stored as `mode: workflow | conversational`, per task, defaulted
from the team, toggleable mid-task via `setAutopilot` / POST
/api/tasks/:id/autopilot) replaces the old realtime task type. On (workflow):
the system drives to the end of the phases (idle pokes, stale recovery, and a
DRIVE MODE prompt block telling the root to advance phases on its own). Off
(conversational): the operator drives; the prompt block tells the agent to
finish the current instruction, rest, and never advance phases uninstructed.
Both settings support phases (0..n).

A run settles via `completeRun`/`failRun`: the task moves to stored status
`settled` (emits `task:run_completed`/`task:run_failed` + state_changed). The
word "settled" never surfaces in UX either — a settled task just presents as
**Completed** or **Failed** (`display_status`), and sending input revives it
(`daemon.inputTask` auto-revives + wakes). `settleTask` remains the
internal/cancel transition; retention sweeps settled tasks.

**Unified input** replaces iterate/retry/resume/realtime-input:
`daemon.inputTask(taskId, text)` — draft: appended to description; settled:
auto-revive + wake; active + review gate: input IS the review response;
active idle: timeline entry + `requestWake` (wakes through the queue, so input
wakes respect the concurrency cap); active busy: accumulates and is delivered
when the turn ends. File uploads (pictures and any file) are the third input kind: the
rail's Add artifact form / paste / drag-drop, `POST /api/tasks/:id/artifacts/upload`
and connect `artifacts/upload-*` create a `kind='upload'` file artifact (bytes
at `<data dir>/artifacts/<taskId>/`), put an `image`/`file` entry on the
timeline and wake the task exactly like text (`ingestArtifactUpload`); the agent
gets the absolute path in the INPUT_FEED and opens it with its own file/image
tool. Audio recording is available on EVERY active task via the
input pipeline (`src/orchestrator/realtime-session.ts`, single-writer lock,
transcribe → summarize → timeline → feed). Phase idx starts 0, increments on
`complete_phase`.

## Test convention

`bun:test`. Each file owns its `Database` (`:memory:` or named file). Call `initializeDatabase(db)`, clean `afterEach`. Construct `ManagerDaemon` with test DB. Call `clearAgentTypeCache()` in `beforeEach` to dodge cache pollution.

**Keep docs current.** Add/rename module → update nearest CLAUDE.md.
