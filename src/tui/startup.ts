import { createInterface } from "node:readline";
import { allServers, loadServers, saveServers, localServer, type ServerConfig } from "./servers";

const ESC = "\x1b[";
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}38;5;245m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}38;5;44m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}38;5;220m${s}${ESC}0m`;

/**
 * Pre-flight server picker, on the normal screen before the alt buffer takes
 * over (plain line input, works over SSH). Lists the local daemon plus every
 * saved Skipper Connect remote; `a` adds one, `d` deletes one. The last pick
 * is remembered and offered as the default.
 */
export async function selectServer(): Promise<ServerConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));
  try {
    for (;;) {
      const file = loadServers();
      const servers = allServers();
      const defIdx = Math.max(0, servers.findIndex((s) => s.id === file.activeId));
      process.stdout.write(
        `\n${bold("Skipper bridge")}  ${dim("where should the dashboard connect?")}\n\n` +
          servers
            .map((s, i) => `  ${cyan(String(i + 1))}) ${s.name.padEnd(22)} ${dim(s.kind === "local" ? `this machine · ${s.baseURL}` : `remote · ${s.baseURL}`)}`)
            .join("\n") +
          `\n\n  ${cyan("a")}) add a remote (Skipper Connect)${file.servers.length ? `   ${cyan("d")}) delete a remote` : ""}\n\n`,
      );
      const answer = (await ask(`  choice [${defIdx + 1}]: `)).trim().toLowerCase();
      if (answer === "") return remember(servers[defIdx]!);
      if (answer === "a") {
        const added = await addRemote(ask);
        if (added) return remember(added);
        continue;
      }
      if (answer === "d" && file.servers.length) {
        const which = (await ask("  delete which number? ")).trim();
        const target = servers[Number(which) - 1];
        if (target && target.kind === "remote") {
          saveServers({ servers: file.servers.filter((s) => s.id !== target.id), activeId: file.activeId === target.id ? null : file.activeId });
          process.stdout.write(`  ${dim(`removed ${target.name}`)}\n`);
        }
        continue;
      }
      const n = Number(answer);
      const pick = servers.find((s, i) => i + 1 === n || s.name.toLowerCase() === answer);
      if (pick) return remember(pick);
      process.stdout.write(`  ${yellow("enter a number, a, or d")}\n`);
    }
  } finally {
    rl.close();
  }
}

async function addRemote(ask: (q: string) => Promise<string>): Promise<ServerConfig | null> {
  process.stdout.write(`\n  ${dim("A remote is a Skipper Connect integrator. Paste the integrator key from its dashboard; it is stored in your data dir (0600).")}\n`);
  const name = (await ask("  name: ")).trim();
  if (!name) return null;
  const baseURL = (await ask("  url (https://…): ")).trim();
  if (!/^(https?|wss?):\/\//i.test(baseURL)) {
    process.stdout.write(`  ${yellow("url must start with https:// (or http:// for a dev worker)")}\n`);
    return null;
  }
  const integratorKey = (await ask("  integrator key: ")).trim();
  if (!integratorKey) {
    process.stdout.write(`  ${yellow("a remote needs a key")}\n`);
    return null;
  }
  const server: ServerConfig = { id: crypto.randomUUID(), name, kind: "remote", baseURL: baseURL.replace(/\/+$/, ""), integratorKey };
  const file = loadServers();
  saveServers({ servers: [...file.servers, server], activeId: server.id });
  return server;
}

function remember(s: ServerConfig): ServerConfig {
  const file = loadServers();
  saveServers({ servers: file.servers, activeId: s.id });
  return s.kind === "local" ? localServer() : s;
}
