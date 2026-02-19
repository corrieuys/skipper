#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const entry = resolve(here, "..", "..", "index.ts");
await import(entry);
