// Per-task glyph screen: one protocol Tree per task, held in memory by the
// daemon. The tree is the single source of truth every open overlay renders
// from; the renderer agent only ever sees `serialize()` and sends frames/ops.
//
// The tree keeps the model's own `w` source texts (artifact:<name>, a path).
// `view()` serializes a copy with those rewritten to servable URLs; that is
// what the browser receives, so the model and the screen never disagree.

import { Tree, parseFrame, parseOps, serializeNode, ProtocolError, isContainer, type UNode } from "./protocol";

/** What the web overlay receives on the `glyph:<taskId>` topic. */
export interface GlyphPushPayload {
  t: "frame";
  /** The full view frame (sources resolved to URLs). */
  s: string;
  /** Same as `s`; kept so the client's resync path has one field to read. */
  frame: string;
  /** Ids of `w` nodes a patch asked to reload (`#x`). */
  refresh?: string[];
}

/** Validates the tree after a change; throw ProtocolError to reject and roll back. */
export type TreeValidator = (root: UNode | null) => void;

/**
 * Skipper's glyph screen is one-way: no buttons, inputs or click actions. Web
 * views are allowed (they only display). Enforced here (not only in the
 * prompt) so a stray `B` from the model never reaches a browser.
 */
export function assertOneWay(root: UNode | null): void {
  if (!root) return;
  const walk = (n: UNode): void => {
    if (n.type === "B" || n.type === "i") {
      throw new ProtocolError(`'${n.type}' nodes are not allowed on a one-way screen (id '${n.id}')`, -1);
    }
    if (n.action !== undefined) {
      throw new ProtocolError(`click actions are not allowed on a one-way screen (id '${n.id}')`, -1);
    }
    if (isContainer(n.type)) for (const ch of n.children) walk(ch);
  };
  walk(root);
}

export class GlyphScreen {
  private readonly tree = new Tree();

  serialize(): string { return this.tree.serialize(); }
  isEmpty(): boolean { return this.tree.root === null; }
  root(): UNode | null { return this.tree.root; }

  /** Replace the whole screen. Throws ProtocolError; the tree is unchanged on failure. */
  render(frame: string, validate?: TreeValidator): void {
    const root = frame.trim() === "" ? null : parseFrame(frame);
    assertOneWay(root);
    validate?.(root);
    this.tree.load(root);
  }

  /**
   * Apply patch ops atomically. Throws ProtocolError; the tree is unchanged on
   * failure. Returns the ids of `#x` refresh ops so the client can reload them.
   */
  patch(ops: string, validate?: TreeValidator): string[] {
    // Tree.apply already snapshots + restores on a bad op; the checks after
    // it run under the same rollback so a patch that sneaks a button in, or a
    // web view pointing outside the task, is undone the same way.
    const before = this.tree.root ? structuredClone(this.tree.root) : null;
    const parsed = parseOps(ops);
    this.tree.apply(parsed);
    try {
      assertOneWay(this.tree.root);
      validate?.(this.tree.root);
    } catch (e) {
      this.tree.load(before);
      throw e;
    }
    return parsed.filter((op) => op.op === "refresh").map((op) => (op as { id: string }).id);
  }

  clear(): void {
    this.tree.load(null);
  }

  /** The frame the browser renders: `w` texts rewritten by `resolve`. */
  view(resolve: (text: string) => string): string {
    if (!this.tree.root) return "";
    const copy = structuredClone(this.tree.root);
    const walk = (n: UNode): void => {
      if (n.type === "w") n.text = resolve(n.text ?? "");
      if (isContainer(n.type)) for (const ch of n.children) walk(ch);
    };
    walk(copy);
    return serializeNode(copy);
  }
}
