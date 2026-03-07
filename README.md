# Skipper (throng)

Skipper is a multi-agent orchestration app for coordinating teams of coding agents.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Database layout:
- `playhive.db`: shared configuration (agents, teams, agent types)
- `playhive-runtime.db`: local runtime state (tasks, events, logs, checkpoints, etc.)

Optional overrides:
- `PLAYHIVE_CONFIG_DB_PATH`
- `PLAYHIVE_RUNTIME_DB_PATH`
- `PLAYHIVE_IDLE_TIMEOUT` (seconds, default `60`)

This project was created using `bun init` in bun v1.2.18. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.