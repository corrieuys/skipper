#!/usr/bin/env bun
// npm/bun launch shim — delegates to the CLI dispatcher (start/stop/serve/…).
// The standalone binary compiles bin/cli.ts directly; this keeps `bunx skipper`
// and a global `bun` install working with the same subcommands.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const entry = resolve(here, "..", "cli.ts");
await import(entry);
