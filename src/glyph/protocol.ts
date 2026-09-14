// Glyph protocol: compact UI tree description + patch ops.
// Vendored from ~/Repositories/glyph-ui/src/protocol.ts (kept byte-compatible with
// the browser port in src/html/public/glyph.js). Skipper only ever sends one-way
// screens (see screen.ts:assertOneWay), but the grammar is kept whole.
//
// Frame grammar
//   node   := type id prop* body?
//   type   := r | c | s | b | t | B | i | w | h | l | T | k
//   id     := [0-9A-Za-z]            one char, unique in tree, stable across frames
//   prop   := *N  (flex weight)  |  >name  (click action, [a-z_]+)  |  !  (emphasis)  |  =  (center children)  |  ;  (end props)
//             flags ! and = take an optional 0/1; in a set op ~x!0 / ~x=0 clears
//   body   := [ node* ]  (containers r c s)  |  "text"  (all leaves but b; no escapes, '"' forbidden)
//            w = url ; h = heading ; l = list, one item per line ; T = table, rows per line, cells split on '|',
//            first line = header ; k = key/value, "key|value" per line
//
// Patch grammar (ops concatenate)
//   -x            remove x and subtree
//   +p[nodes]     append under p          +p@n[nodes]   insert at index n
//   ~x<prop|type|"text">+   set fields on x, e.g. ~xr  ~x"hi"  ~x>save  ~x*2
//   ^xp           move x under p          ^xp@n         move to index n
//   %xy           swap positions of x and y
//   #x            refresh x (reloads a web view; no tree change)

export type ContainerType = "r" | "c" | "s";
export type LeafType = "b" | "t" | "B" | "i" | "w" | "h" | "l" | "T" | "k";
export type NodeType = ContainerType | LeafType;

export const CONTAINERS: ReadonlySet<string> = new Set(["r", "c", "s"]);
export const LEAVES: ReadonlySet<string> = new Set(["b", "t", "B", "i", "w", "h", "l", "T", "k"]);
export const isContainer = (t: string): t is ContainerType => CONTAINERS.has(t);
export const isType = (t: string | undefined): t is NodeType =>
  t !== undefined && (CONTAINERS.has(t) || LEAVES.has(t));

export interface UNode {
  type: NodeType;
  id: string;
  weight?: number;
  action?: string;
  text?: string;
  emphasis?: boolean;
  center?: boolean;
  children: UNode[];
}

export type Op =
  | { op: "remove"; id: string }
  | { op: "insert"; parent: string; index?: number; nodes: UNode[] }
  | { op: "set"; id: string; type?: NodeType; text?: string; action?: string; weight?: number; emphasis?: boolean; center?: boolean }
  | { op: "move"; id: string; parent: string; index?: number }
  | { op: "swap"; a: string; b: string }
  | { op: "refresh"; id: string };

export class ProtocolError extends Error {
  constructor(message: string, public readonly at: number) {
    super(at >= 0 ? `${message} (at ${at})` : message);
    this.name = "ProtocolError";
  }
}

const ID_RE = /[0-9A-Za-z]/;
const ACTION_RE = /[a-z_]/;
const WS_RE = /\s/;

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string | undefined { return this.s[this.i]; }
  next(): string | undefined { return this.s[this.i++]; }
  done(): boolean { return this.i >= this.s.length; }
  ws(): void { while (!this.done() && WS_RE.test(this.s[this.i]!)) this.i++; }
  fail(msg: string): never { throw new ProtocolError(msg, this.i); }
  expect(ch: string): void {
    this.ws();
    if (this.peek() !== ch) this.fail(`expected '${ch}'`);
    this.i++;
  }
  id(): string {
    const ch = this.next();
    if (ch === undefined || !ID_RE.test(ch)) this.fail("expected id [0-9A-Za-z]");
    return ch;
  }
  digits(): number {
    let n = "";
    while (!this.done() && /[0-9]/.test(this.peek()!)) n += this.next();
    if (!n) this.fail("expected number");
    return Number(n);
  }
  /** Optional 0/1 digit after a flag prop; absent = true. */
  flag(): boolean {
    const p = this.peek();
    if (p === "0" || p === "1") { this.next(); return p === "1"; }
    return true;
  }
  name(): string {
    let n = "";
    while (!this.done() && ACTION_RE.test(this.peek()!)) n += this.next();
    if (!n) this.fail("expected action name [a-z_]+");
    return n;
  }
  quoted(): string {
    this.expect('"');
    const end = this.s.indexOf('"', this.i);
    if (end < 0) this.fail("unterminated text");
    const text = this.s.slice(this.i, end);
    this.i = end + 1;
    return text;
  }
}

function parseNode(c: Cursor): UNode {
  c.ws();
  const type = c.next();
  if (!isType(type)) c.fail(`unknown node type '${type ?? "<end>"}'`);
  const node: UNode = { type, id: c.id(), children: [] };
  for (;;) {
    c.ws();
    const ch = c.peek();
    if (ch === "*") { c.next(); node.weight = c.digits(); continue; }
    if (ch === ">") { c.next(); node.action = c.name(); continue; }
    if (ch === "!") { c.next(); node.emphasis = c.flag(); continue; }
    if (ch === "=") { c.next(); node.center = c.flag(); continue; }
    if (ch === ";") { c.next(); break; }
    if (ch === "[") {
      if (!isContainer(type)) c.fail(`'${type}' cannot have children`);
      c.next();
      node.children = parseChildren(c);
      break;
    }
    if (ch === '"') {
      if (isContainer(type) || type === "b") c.fail(`'${type}' cannot have text`);
      node.text = c.quoted();
      break;
    }
    break;
  }
  return node;
}

function parseChildren(c: Cursor): UNode[] {
  const out: UNode[] = [];
  for (;;) {
    c.ws();
    if (c.peek() === "]") { c.next(); return out; }
    if (c.done()) c.fail("expected ']'");
    out.push(parseNode(c));
  }
}

export function parseFrame(s: string): UNode {
  const c = new Cursor(s);
  const root = parseNode(c);
  c.ws();
  if (!c.done()) c.fail("trailing input");
  indexInto(root, null, new Map(), new Map());
  return root;
}

export function parseOps(s: string): Op[] {
  const c = new Cursor(s);
  const ops: Op[] = [];
  for (;;) {
    c.ws();
    if (c.done()) return ops;
    const at = c.i;
    const ch = c.next();
    switch (ch) {
      case "-":
        ops.push({ op: "remove", id: c.id() });
        break;
      case "+": {
        const parent = c.id();
        let index: number | undefined;
        if (c.peek() === "@") { c.next(); index = c.digits(); }
        c.expect("[");
        ops.push({ op: "insert", parent, index, nodes: parseChildren(c) });
        break;
      }
      case "~": {
        const id = c.id();
        const op: Op = { op: "set", id };
        let any = false;
        for (;;) {
          const p = c.peek();
          if (p === "*") { c.next(); op.weight = c.digits(); }
          else if (p === ">") { c.next(); op.action = c.name(); }
          else if (p === "!") { c.next(); op.emphasis = c.flag(); }
          else if (p === "=") { c.next(); op.center = c.flag(); }
          else if (p === '"') { op.text = c.quoted(); }
          else if (isType(p) && op.type === undefined && !any) { c.next(); op.type = p; }
          else break;
          any = true;
        }
        if (!any) c.fail("empty set op");
        ops.push(op);
        break;
      }
      case "^": {
        const id = c.id();
        const parent = c.id();
        let index: number | undefined;
        if (c.peek() === "@") { c.next(); index = c.digits(); }
        ops.push({ op: "move", id, parent, index });
        break;
      }
      case "%":
        ops.push({ op: "swap", a: c.id(), b: c.id() });
        break;
      case "#":
        ops.push({ op: "refresh", id: c.id() });
        break;
      default:
        throw new ProtocolError(`unknown op '${ch}'`, at);
    }
  }
}

export function serializeNode(n: UNode): string {
  let s = n.type + n.id;
  if (n.weight !== undefined) s += `*${n.weight}`;
  if (n.action !== undefined) s += `>${n.action}`;
  if (n.emphasis) s += "!";
  if (n.center) s += "=";
  if (n.children.length) s += `[${n.children.map(serializeNode).join("")}]`;
  else if (n.text !== undefined) s += `"${n.text}"`;
  else if (n.action !== undefined || n.emphasis || n.center) s += ";";
  return s;
}

export class Tree {
  root: UNode | null = null;
  private nodes = new Map<string, UNode>();
  private parents = new Map<string, UNode>();

  static fromFrame(s: string): Tree {
    const t = new Tree();
    t.load(parseFrame(s));
    return t;
  }

  load(root: UNode | null): void {
    const nodes = new Map<string, UNode>();
    const parents = new Map<string, UNode>();
    if (root) indexInto(root, null, nodes, parents);
    this.root = root;
    this.nodes = nodes;
    this.parents = parents;
  }

  has(id: string): boolean { return this.nodes.has(id); }
  ids(): string[] { return [...this.nodes.keys()]; }
  get(id: string): UNode {
    const n = this.nodes.get(id);
    if (!n) throw new ProtocolError(`unknown id '${id}'`, -1);
    return n;
  }
  parentOf(id: string): UNode | undefined { return this.parents.get(id); }

  serialize(): string { return this.root ? serializeNode(this.root) : ""; }

  /** Apply ops atomically: on failure the tree is left unchanged. */
  apply(ops: Op[]): void {
    const snapshot = this.root ? structuredClone(this.root) : null;
    try {
      for (const op of ops) this.applyOne(op);
    } catch (e) {
      this.load(snapshot);
      throw e;
    }
  }

  applyOps(s: string): void { this.apply(parseOps(s)); }

  private applyOne(op: Op): void {
    switch (op.op) {
      case "remove": {
        const n = this.get(op.id);
        const p = this.parents.get(op.id);
        if (!p) { this.load(null); return; }
        p.children.splice(p.children.indexOf(n), 1);
        this.unindex(n);
        return;
      }
      case "insert": {
        const p = this.get(op.parent);
        if (!isContainer(p.type)) throw new ProtocolError(`'${op.parent}' is not a container`, -1);
        for (const n of op.nodes) indexInto(n, p, this.nodes, this.parents);
        p.children.splice(clampIndex(op.index, p.children.length), 0, ...op.nodes);
        return;
      }
      case "set": {
        const n = this.get(op.id);
        if (op.type !== undefined && op.type !== n.type) {
          if (isContainer(op.type) !== isContainer(n.type))
            throw new ProtocolError(`cannot retype '${op.id}' between container and leaf`, -1);
          n.type = op.type;
        }
        if (op.text !== undefined) {
          if (isContainer(n.type) || n.type === "b") throw new ProtocolError(`'${op.id}' cannot have text`, -1);
          n.text = op.text;
        }
        if (op.action !== undefined) n.action = op.action;
        if (op.weight !== undefined) n.weight = op.weight;
        if (op.emphasis !== undefined) { if (op.emphasis) n.emphasis = true; else delete n.emphasis; }
        if (op.center !== undefined) { if (op.center) n.center = true; else delete n.center; }
        return;
      }
      case "move": {
        const n = this.get(op.id);
        const p = this.get(op.parent);
        if (!isContainer(p.type)) throw new ProtocolError(`'${op.parent}' is not a container`, -1);
        const old = this.parents.get(op.id);
        if (!old) throw new ProtocolError("cannot move root", -1);
        if (n === p || this.isAncestor(n, p)) throw new ProtocolError(`cannot move '${op.id}' into itself`, -1);
        old.children.splice(old.children.indexOf(n), 1);
        p.children.splice(clampIndex(op.index, p.children.length), 0, n);
        this.parents.set(op.id, p);
        return;
      }
      case "refresh":
        this.get(op.id); // validate only; the front end reloads the element
        return;
      case "swap": {
        const a = this.get(op.a);
        const b = this.get(op.b);
        if (a === b) return;
        const pa = this.parents.get(op.a);
        const pb = this.parents.get(op.b);
        if (!pa || !pb) throw new ProtocolError("cannot swap root", -1);
        if (this.isAncestor(a, b) || this.isAncestor(b, a))
          throw new ProtocolError(`cannot swap nested nodes '${op.a}','${op.b}'`, -1);
        const ia = pa.children.indexOf(a);
        const ib = pb.children.indexOf(b);
        pa.children[ia] = b;
        pb.children[ib] = a;
        this.parents.set(op.a, pb);
        this.parents.set(op.b, pa);
        return;
      }
    }
  }

  private isAncestor(maybeAncestor: UNode, n: UNode): boolean {
    let p = this.parents.get(n.id);
    while (p) {
      if (p === maybeAncestor) return true;
      p = this.parents.get(p.id);
    }
    return false;
  }

  private unindex(n: UNode): void {
    this.nodes.delete(n.id);
    this.parents.delete(n.id);
    for (const ch of n.children) this.unindex(ch);
  }
}

function indexInto(n: UNode, parent: UNode | null, nodes: Map<string, UNode>, parents: Map<string, UNode>): void {
  if (nodes.has(n.id)) throw new ProtocolError(`duplicate id '${n.id}'`, -1);
  nodes.set(n.id, n);
  if (parent) parents.set(n.id, parent);
  for (const ch of n.children) indexInto(ch, n, nodes, parents);
}

function clampIndex(i: number | undefined, len: number): number {
  if (i === undefined) return len;
  return Math.max(0, Math.min(i, len));
}
