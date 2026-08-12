# Grok — future features & known gaps

Design notes for improvements to the experimental `grok` provider that are
understood but not yet built. Each entry states the problem, why it exists, and
the intended fix — enough to pick up and implement without re-deriving it.

---

## Concurrency-safe MCP config injection

**Status:** latent bug, not yet fixed. Does not corrupt data; can cause a grok
agent to start with no `skipper-daemon` tools.

### The problem

`agents/mcp-spawn-helper.ts:injectGrokDaemonConfig` patches
`<workingDir>/.grok/config.toml` with a marker-delimited `skipper-daemon` block
at spawn, and `restoreMcpConfigFiles` writes the original bytes back on agent
exit. Each agent does this independently.

Grok has **no per-process config path** — no `--mcp-config` flag, no
`CODEX_HOME`-style env. It only reads `.grok/config.toml` walking from cwd up to
the git root. So every grok agent sharing a working directory shares that one
file. Delegated grok children default to the orchestrator cwd
(`process.cwd()`), so a grok-heavy team routinely runs two or more grok agents
in the same dir at once (e.g. a grok root delegating to a grok child).

When they overlap, the independent write/restore races:

- Agent A spawns: `original = null`, writes the block, records `restore = {content: null}`.
- Agent B spawns while A runs: reads the current file (A's block), records
  `restore = {content: <A's file, block included>}` — B mistakes A's block for
  pre-existing content.
- **A exits: restore writes `null` → deletes the file while B is still live.**
  If B has already read its config at startup, B's session survives; but a grok
  agent starting in that window reads a missing/partial config and comes up with
  **no `skipper-daemon` server → no daemon tools**, with no error.
- B exits: restore recreates the file with A's now-stale block → leftover
  pollution in the user's repo.

Note: the "skipper-daemon connected but zero tools" reports were NOT this — that
was a separate, now-fixed bug where the injected URL collided with an operator
`skipper` server at the same `http://host:port/mcp` (grok collapses same-URL
servers), fixed by the `?client=skipper-daemon` URL marker in
`injectDaemonMcpServer`. This concurrency race is a distinct, still-open risk:
it strikes only when two grok agents share a working dir and one exits mid-run,
deleting the config the other still needs.

### Why the shared file is safe to share

The injected block is **content-identical** for every agent in a dir. The bearer
is the literal `${SKIPPER_AGENT_TOKEN}`, which each grok process expands from its
**own** env at load time. One block correctly serves all agents sharing the dir.
The bug is purely the write/restore *lifecycle*, not the content.

### The fix — refcount the shared block

Replace per-agent write/restore with a per-`configPath` refcount held in a
module-level map in `mcp-spawn-helper.ts`:

```ts
Map<configPath, { refs: number; original: string | null }>
```

**Acquire** (`grokConfigAcquire(workingDir, daemonUrl)`), for
`<workingDir>/.grok/config.toml`:

- First agent for this path: capture the **true** original (file bytes, or
  `null` if absent), strip any stale `skipper-daemon` blocks, write
  `base + block`, store `{ refs: 1, original }`.
- Subsequent agents: increment `refs`, ensure the block is present (idempotent
  rewrite), **do not** recapture `original`.

**Release** (`grokConfigRelease(configPath)`), on agent exit:

- Decrement `refs`.
- `refs === 0` → write back the stored `original` (or delete the file + prune the
  `.grok` dir if we created it), drop the map entry.
- `refs > 0` → do nothing; the block stays for still-running siblings.

### Why it's correct

- **Atomicity:** Bun is single-threaded and `readFileSync`/`writeFileSync` do not
  yield, so each acquire/release critical section runs to completion with no
  interleaving. The only async gap is between spawn and exit — exactly what the
  refcount spans.
- Kills all three failure modes: a sibling's exit no longer deletes a live
  agent's config (block lives until the last agent leaves); `original` is
  captured once, so a sibling's block is never mistaken for pre-existing content;
  the true original is restored only on the last release, so no stale leftover.
- **Crash self-healing:** if an agent dies without releasing, `refs` leaks in
  memory only — the next acquire already calls `stripGrokDaemonBlocks` before
  rewriting, so a stray block is cleaned on the next grok spawn, and a daemon
  restart drops the map entirely. No persistent corruption.
- Independent working dirs are independent map entries (no cross-talk). A user's
  own pre-existing `.grok/config.toml` is captured as `original` on first acquire
  and restored verbatim on last release.

### Integration

Contained to `mcp-spawn-helper.ts`: the grok branch of `injectDaemonMcpServer`
calls `grokConfigAcquire` instead of pushing a `restoreFiles` entry, and the
agent-exit path calls `grokConfigRelease(configPath)` instead of
`restoreMcpConfigFiles` for the grok config. No behavior change for the
single-agent case.

### Test

- acquire twice on one dir, release once → block still present; release again →
  file restored to original.
- interleaved order (A acquire, B acquire, A release, B release) → repo left
  clean, no leftover `.grok/config.toml`.
- pre-existing user `.grok/config.toml` with the user's own servers → restored
  verbatim after the last release.
