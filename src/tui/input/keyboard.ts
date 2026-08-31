/** Parsed key intents the controller acts on. Raw escape sequences → intents. */
export type KeyEvent =
  | { type: "quit" }
  | { type: "up" }
  | { type: "down" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "nextPane" }
  | { type: "prevPane" }
  | { type: "resync" }
  | { type: "unknown"; raw: string };

/**
 * Decode one chunk of raw stdin into a key intent. Raw mode delivers control
 * chars and CSI escape sequences directly. Covers the read-only key set; new
 * bindings (for future interactivity) are added here only.
 */
export function decodeKey(data: string): KeyEvent {
  switch (data) {
    case "\x03": // Ctrl-C
    case "q":
    case "Q":
      return { type: "quit" };
    case "\x1b[A":
    case "k":
      return { type: "up" };
    case "\x1b[B":
    case "j":
      return { type: "down" };
    case "\x1b[5~":
      return { type: "pageUp" };
    case "\x1b[6~":
      return { type: "pageDown" };
    case "\t":
      return { type: "nextPane" };
    case "\x1b[Z": // Shift-Tab
      return { type: "prevPane" };
    case "r":
    case "R":
      return { type: "resync" };
    default:
      return { type: "unknown", raw: data };
  }
}
