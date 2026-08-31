import { createInterface } from "node:readline";
import { ansi } from "./render/terminal";

export type TransportChoice = "local" | "connect";

/**
 * Pre-flight menu shown before the full-screen view takes over. Lets the
 * operator pick where the dashboard reads from. Runs on the normal screen
 * (no alt buffer yet) with line input, so it works over pipes and SSH.
 *
 * `connectAvailable` is false until the Connect transport ships; picking it
 * then prints why and re-prompts.
 */
export async function selectTransport(opts: {
  connectAvailable: boolean;
  defaultChoice?: TransportChoice;
}): Promise<TransportChoice> {
  const def = opts.defaultChoice ?? "local";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  try {
    process.stdout.write(
      `\n${ansi.bold}${ansi.white}Skipper Dashboard${ansi.reset}\n` +
        `${ansi.gray}Where should the dashboard connect?${ansi.reset}\n\n` +
        `  ${ansi.cyan}1${ansi.reset}) local     ${ansi.gray}this machine's running daemon${ansi.reset}\n` +
        `  ${ansi.cyan}2${ansi.reset}) connect   ${ansi.gray}a remote instance via Skipper Connect${
          opts.connectAvailable ? "" : " (not available yet)"
        }${ansi.reset}\n\n`,
    );

    for (;;) {
      const answer = (await ask(`  choice [${def === "local" ? "1" : "2"}]: `)).trim().toLowerCase();
      const choice: TransportChoice | null =
        answer === "" ? def : answer === "1" || answer === "local" ? "local" : answer === "2" || answer === "connect" ? "connect" : null;

      if (choice === null) {
        process.stdout.write(`  ${ansi.yellow}enter 1 or 2${ansi.reset}\n`);
        continue;
      }
      if (choice === "connect" && !opts.connectAvailable) {
        process.stdout.write(
          `  ${ansi.yellow}Connect mode is not available yet — it needs the integrator's\n` +
            `  client API, which is not part of this build. Use local.${ansi.reset}\n\n`,
        );
        continue;
      }
      return choice;
    }
  } finally {
    rl.close();
  }
}
