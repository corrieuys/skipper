/**
 * Glyph overlay: renders a task's glyph screen (a compact UI-tree string) with
 * FLIP animation between frames. Plain-JS port of glyph-ui's protocol.ts +
 * engine.ts (~/Repositories/glyph-ui), trimmed to the one-way subset Skipper
 * sends: no buttons, inputs, web views or click events.
 *
 * Wiring:
 *   Skipper.glyph.open(taskId)  opens #tc-glyph-modal, POSTs /api/tasks/:id/glyph/open
 *                               for the current frame, and connects a JSON socket
 *                               on /ws/ui?format=json&topics=glyph:<id>
 *   Skipper.glyph.close()       closes the modal and the socket
 *   Skipper.glyph.reset()       POST /api/tasks/:id/glyph/reset (drop screen + session)
 *
 * Server push payloads (resource "glyph"): {t:"frame"|"ops", s, frame}. The
 * client applies `s` and resyncs from `frame` on any drift or error, so a
 * missed message can never wedge the screen.
 */
(function (window, document) {
  "use strict";

  // ------------------------------------------------------------ protocol

  var CONTAINERS = { r: 1, c: 1, s: 1 };
  var LEAVES = { b: 1, t: 1, B: 1, i: 1, w: 1, h: 1, l: 1, T: 1, k: 1 };
  function isContainer(t) { return !!CONTAINERS[t]; }
  function isType(t) { return !!(t && (CONTAINERS[t] || LEAVES[t])); }

  function ProtocolError(message, at) {
    this.name = "ProtocolError";
    this.message = at >= 0 ? message + " (at " + at + ")" : message;
    this.at = at;
  }
  ProtocolError.prototype = Object.create(Error.prototype);

  var ID_RE = /[0-9A-Za-z]/;
  var ACTION_RE = /[a-z_]/;
  var WS_RE = /\s/;

  function Cursor(s) { this.s = s; this.i = 0; }
  Cursor.prototype.peek = function () { return this.s[this.i]; };
  Cursor.prototype.next = function () { return this.s[this.i++]; };
  Cursor.prototype.done = function () { return this.i >= this.s.length; };
  Cursor.prototype.ws = function () { while (!this.done() && WS_RE.test(this.s[this.i])) this.i++; };
  Cursor.prototype.fail = function (msg) { throw new ProtocolError(msg, this.i); };
  Cursor.prototype.expect = function (ch) { this.ws(); if (this.peek() !== ch) this.fail("expected '" + ch + "'"); this.i++; };
  Cursor.prototype.id = function () { var ch = this.next(); if (ch === undefined || !ID_RE.test(ch)) this.fail("expected id [0-9A-Za-z]"); return ch; };
  Cursor.prototype.digits = function () { var n = ""; while (!this.done() && /[0-9]/.test(this.peek())) n += this.next(); if (!n) this.fail("expected number"); return Number(n); };
  Cursor.prototype.flag = function () { var p = this.peek(); if (p === "0" || p === "1") { this.next(); return p === "1"; } return true; };
  Cursor.prototype.name = function () { var n = ""; while (!this.done() && ACTION_RE.test(this.peek())) n += this.next(); if (!n) this.fail("expected action name [a-z_]+"); return n; };
  Cursor.prototype.quoted = function () {
    this.expect('"');
    var end = this.s.indexOf('"', this.i);
    if (end < 0) this.fail("unterminated text");
    var text = this.s.slice(this.i, end);
    this.i = end + 1;
    return text;
  };

  function parseNode(c) {
    c.ws();
    var type = c.next();
    if (!isType(type)) c.fail("unknown node type '" + (type === undefined ? "<end>" : type) + "'");
    var node = { type: type, id: c.id(), children: [] };
    for (;;) {
      c.ws();
      var ch = c.peek();
      if (ch === "*") { c.next(); node.weight = c.digits(); continue; }
      if (ch === ">") { c.next(); node.action = c.name(); continue; }
      if (ch === "!") { c.next(); node.emphasis = c.flag(); continue; }
      if (ch === "=") { c.next(); node.center = c.flag(); continue; }
      if (ch === ";") { c.next(); break; }
      if (ch === "[") {
        if (!isContainer(type)) c.fail("'" + type + "' cannot have children");
        c.next();
        node.children = parseChildren(c);
        break;
      }
      if (ch === '"') {
        if (isContainer(type) || type === "b") c.fail("'" + type + "' cannot have text");
        node.text = c.quoted();
        break;
      }
      break;
    }
    return node;
  }

  function parseChildren(c) {
    var out = [];
    for (;;) {
      c.ws();
      if (c.peek() === "]") { c.next(); return out; }
      if (c.done()) c.fail("expected ']'");
      out.push(parseNode(c));
    }
  }

  function parseFrame(s) {
    var c = new Cursor(s);
    var root = parseNode(c);
    c.ws();
    if (!c.done()) c.fail("trailing input");
    indexInto(root, null, {}, {});
    return root;
  }

  function parseOps(s) {
    var c = new Cursor(s);
    var ops = [];
    for (;;) {
      c.ws();
      if (c.done()) return ops;
      var at = c.i;
      var ch = c.next();
      switch (ch) {
        case "-": ops.push({ op: "remove", id: c.id() }); break;
        case "+": {
          var parent = c.id();
          var index;
          if (c.peek() === "@") { c.next(); index = c.digits(); }
          c.expect("[");
          ops.push({ op: "insert", parent: parent, index: index, nodes: parseChildren(c) });
          break;
        }
        case "~": {
          var id = c.id();
          var op = { op: "set", id: id };
          var any = false;
          for (;;) {
            var p = c.peek();
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
          var mid = c.id();
          var mparent = c.id();
          var mindex;
          if (c.peek() === "@") { c.next(); mindex = c.digits(); }
          ops.push({ op: "move", id: mid, parent: mparent, index: mindex });
          break;
        }
        case "%": ops.push({ op: "swap", a: c.id(), b: c.id() }); break;
        case "#": ops.push({ op: "refresh", id: c.id() }); break;
        default: throw new ProtocolError("unknown op '" + ch + "'", at);
      }
    }
  }

  function serializeNode(n) {
    var s = n.type + n.id;
    if (n.weight !== undefined) s += "*" + n.weight;
    if (n.action !== undefined) s += ">" + n.action;
    if (n.emphasis) s += "!";
    if (n.center) s += "=";
    if (n.children.length) s += "[" + n.children.map(serializeNode).join("") + "]";
    else if (n.text !== undefined) s += '"' + n.text + '"';
    else if (n.action !== undefined || n.emphasis || n.center) s += ";";
    return s;
  }

  function indexInto(n, parent, nodes, parents) {
    if (nodes[n.id]) throw new ProtocolError("duplicate id '" + n.id + "'", -1);
    nodes[n.id] = n;
    if (parent) parents[n.id] = parent;
    for (var i = 0; i < n.children.length; i++) indexInto(n.children[i], n, nodes, parents);
  }

  function clampIndex(i, len) { return i === undefined ? len : Math.max(0, Math.min(i, len)); }

  function Tree() { this.root = null; this.nodes = {}; this.parents = {}; }
  Tree.prototype.load = function (root) {
    var nodes = {}, parents = {};
    if (root) indexInto(root, null, nodes, parents);
    this.root = root; this.nodes = nodes; this.parents = parents;
  };
  Tree.prototype.get = function (id) { var n = this.nodes[id]; if (!n) throw new ProtocolError("unknown id '" + id + "'", -1); return n; };
  Tree.prototype.serialize = function () { return this.root ? serializeNode(this.root) : ""; };
  Tree.prototype.applyOps = function (s) {
    var ops = parseOps(s);
    var snapshot = this.root ? JSON.parse(JSON.stringify(this.root)) : null;
    try { for (var i = 0; i < ops.length; i++) this.applyOne(ops[i]); }
    catch (e) { this.load(snapshot); throw e; }
  };
  Tree.prototype.isAncestor = function (maybe, n) {
    var p = this.parents[n.id];
    while (p) { if (p === maybe) return true; p = this.parents[p.id]; }
    return false;
  };
  Tree.prototype.unindex = function (n) {
    delete this.nodes[n.id]; delete this.parents[n.id];
    for (var i = 0; i < n.children.length; i++) this.unindex(n.children[i]);
  };
  Tree.prototype.applyOne = function (op) {
    var n, p, old, i;
    switch (op.op) {
      case "remove":
        n = this.get(op.id); p = this.parents[op.id];
        if (!p) { this.load(null); return; }
        p.children.splice(p.children.indexOf(n), 1);
        this.unindex(n);
        return;
      case "insert":
        p = this.get(op.parent);
        if (!isContainer(p.type)) throw new ProtocolError("'" + op.parent + "' is not a container", -1);
        for (i = 0; i < op.nodes.length; i++) indexInto(op.nodes[i], p, this.nodes, this.parents);
        Array.prototype.splice.apply(p.children, [clampIndex(op.index, p.children.length), 0].concat(op.nodes));
        return;
      case "set":
        n = this.get(op.id);
        if (op.type !== undefined && op.type !== n.type) {
          if (isContainer(op.type) !== isContainer(n.type)) throw new ProtocolError("cannot retype '" + op.id + "' between container and leaf", -1);
          n.type = op.type;
        }
        if (op.text !== undefined) {
          if (isContainer(n.type) || n.type === "b") throw new ProtocolError("'" + op.id + "' cannot have text", -1);
          n.text = op.text;
        }
        if (op.action !== undefined) n.action = op.action;
        if (op.weight !== undefined) n.weight = op.weight;
        if (op.emphasis !== undefined) { if (op.emphasis) n.emphasis = true; else delete n.emphasis; }
        if (op.center !== undefined) { if (op.center) n.center = true; else delete n.center; }
        return;
      case "move":
        n = this.get(op.id); p = this.get(op.parent);
        if (!isContainer(p.type)) throw new ProtocolError("'" + op.parent + "' is not a container", -1);
        old = this.parents[op.id];
        if (!old) throw new ProtocolError("cannot move root", -1);
        if (n === p || this.isAncestor(n, p)) throw new ProtocolError("cannot move '" + op.id + "' into itself", -1);
        old.children.splice(old.children.indexOf(n), 1);
        p.children.splice(clampIndex(op.index, p.children.length), 0, n);
        this.parents[op.id] = p;
        return;
      case "refresh":
        this.get(op.id);
        return;
      case "swap": {
        var a = this.get(op.a), b = this.get(op.b);
        if (a === b) return;
        var pa = this.parents[op.a], pb = this.parents[op.b];
        if (!pa || !pb) throw new ProtocolError("cannot swap root", -1);
        if (this.isAncestor(a, b) || this.isAncestor(b, a)) throw new ProtocolError("cannot swap nested nodes '" + op.a + "','" + op.b + "'", -1);
        var ia = pa.children.indexOf(a), ib = pb.children.indexOf(b);
        pa.children[ia] = b; pb.children[ib] = a;
        this.parents[op.a] = pb; this.parents[op.b] = pa;
        return;
      }
    }
  };

  // ------------------------------------------------------------ renderer

  var DURATION = 420;

  function spring(zeta, omega) {
    var wd = omega * Math.sqrt(1 - zeta * zeta);
    return function (t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
    };
  }
  var easePos = spring(0.82, 14);
  var easeSizeRaw = spring(0.58, 13);
  function easeSize(t) { return easeSizeRaw(Math.max(0, (t - 0.06) / 0.94)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function same(a, b) { return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5; }

  var TAG = { l: "ul", k: "dl" };

  // A web view is an <img> for image sources (the server marks them with
  // ?glyph=image) and a sandboxed <iframe> for pages.
  function isImageSource(url) { return /[?&]glyph=image(&|$)/.test(url || ""); }
  function tagFor(node) {
    if (node.type === "w") return isImageSource(node.text) ? "img" : "iframe";
    return TAG[node.type] || "div";
  }

  function Renderer(stage, ghosts) {
    this.stage = stage;
    this.ghosts = ghosts;
    this.tree = new Tree();
    this.els = {};
    this.layout = {};
    this.anims = {};
    this.raf = 0;
    this.changed = {};
    this.freshTimers = {};
    this.everCommitted = false;
    var self = this;
    this.onResize = function () {
      self.anims = {};
      for (var id in self.els) { self.els[id].style.transform = ""; }
      for (var id2 in self.els) self.layout[id2] = rectOf(self.els[id2]);
      self.frame(performance.now());
    };
    this.onVisibility = function () { if (document.hidden) { self.anims = {}; self.frame(performance.now()); } };
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  Renderer.prototype.destroy = function () {
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.stage.style.zoom = "";
    this.stage.replaceChildren();
    this.ghosts.replaceChildren();
    for (var k in this.freshTimers) clearTimeout(this.freshTimers[k]);
    this.els = {}; this.layout = {}; this.anims = {}; this.changed = {}; this.freshTimers = {}; this.everCommitted = false;
    this.tree.load(null);
  };

  Renderer.prototype.create = function (node) {
    var tag = tagFor(node);
    var el = document.createElement(tag);
    el.dataset.id = node.id;
    if (tag === "iframe") {
      el.referrerPolicy = "no-referrer";
      el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
      el.setAttribute("loading", "lazy");
    }
    if (tag === "img") { el.alt = ""; el.decoding = "async"; }
    return el;
  };

  function lines(text) { return text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean); }
  function cells(line) { return line.split("|").map(function (c) { return c.trim(); }); }

  function renderData(el, type, text) {
    el.replaceChildren();
    var i, ls = lines(text);
    if (type === "l") {
      for (i = 0; i < ls.length; i++) { var li = document.createElement("li"); li.textContent = ls[i]; el.append(li); }
      return;
    }
    if (type === "k") {
      for (i = 0; i < ls.length; i++) {
        var kv = cells(ls[i]);
        var dt = document.createElement("dt"); dt.textContent = kv[0] || "";
        var dd = document.createElement("dd"); dd.textContent = kv.slice(1).join(" | ");
        el.append(dt, dd);
      }
      return;
    }
    if (ls.length === 0) return;
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var tr = document.createElement("tr");
    cells(ls[0]).forEach(function (c) { var th = document.createElement("th"); th.textContent = c; tr.append(th); });
    thead.append(tr);
    var tbody = document.createElement("tbody");
    for (i = 1; i < ls.length; i++) {
      var r = document.createElement("tr");
      cells(ls[i]).forEach(function (c) { var td = document.createElement("td"); td.textContent = c; r.append(td); });
      tbody.append(r);
    }
    table.append(thead, tbody);
    el.append(table);
  }

  Renderer.prototype.mount = function (node, depth, seen) {
    seen[node.id] = true;
    var tag = tagFor(node).toUpperCase();
    var el = this.els[node.id];
    if (el && el.tagName !== tag) {
      var fresh = this.create(node);
      el.replaceWith(fresh);
      el = fresh;
    }
    if (!el) { el = this.create(node); this.changed[node.id] = true; }
    this.els[node.id] = el;

    if (el.dataset.type !== node.type) {
      if (isContainer(node.type)) {
        Array.prototype.slice.call(el.childNodes).forEach(function (n) { if (n.nodeType !== Node.ELEMENT_NODE) n.remove(); });
      }
      delete el.dataset.src;
      el.dataset.type = node.type;
      this.changed[node.id] = true;
    }
    // Containers below the root are cards: they carry sk-panel so every theme's
    // panel rules (glass blur, borders, retro chrome) apply to them unchanged.
    el.className = "gl-n gl-n-" + node.type + (isContainer(node.type) && depth > 0 ? " sk-panel" : "");
    el.dataset.depth = String(depth);
    var grow = node.weight !== undefined ? node.weight : (isContainer(node.type) || node.type === "b" ? 1 : 0);
    el.style.flexGrow = String(grow);
    el.style.flexBasis = grow === 0 ? "auto" : "";
    el.style.flexShrink = grow === 0 && isContainer(node.type) ? "0" : "";
    el.classList.toggle("gl-em", !!node.emphasis);
    el.classList.toggle("gl-ctr", !!node.center);

    if (node.type === "w") {
      var src = node.text || "about:blank";
      if (el.getAttribute("src") !== src) { el.setAttribute("src", src); this.changed[node.id] = true; }
    } else if (node.type === "l" || node.type === "T" || node.type === "k") {
      var text = node.text || "";
      if (el.dataset.src !== text) { el.dataset.src = text; renderData(el, node.type, text); this.changed[node.id] = true; }
    } else if (!isContainer(node.type) && node.type !== "b") {
      var t2 = node.text || "";
      if (el.textContent !== t2) { el.textContent = t2; this.changed[node.id] = true; }
    }

    if (isContainer(node.type)) {
      var kids = [];
      for (var i = 0; i < node.children.length; i++) kids.push(this.mount(node.children[i], depth + 1, seen));
      for (var j = 0; j < kids.length; j++) {
        if (el.children[j] !== kids[j]) el.insertBefore(kids[j], el.children[j] || null);
      }
    }
    return el;
  };

  Renderer.prototype.ghost = function (el, r) {
    var clone = el.cloneNode(true);
    clone.querySelectorAll(".gl-n").forEach(function (c) { c.style.transform = ""; });
    clone.style.left = r.x + "px"; clone.style.top = r.y + "px";
    clone.style.width = r.w + "px"; clone.style.height = r.h + "px";
    clone.style.transform = ""; clone.style.transformOrigin = "50% 50%";
    this.ghosts.append(clone);
    var anim = clone.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.88)" }],
      { duration: 240, easing: "cubic-bezier(0.4, 0, 0.7, 1)", fill: "forwards" }
    );
    anim.addEventListener("finish", function () { clone.remove(); });
  };

  Renderer.prototype.commit = function () {
    var id, el;
    var first = {};
    for (id in this.els) first[id] = rectOf(this.els[id]);
    for (id in this.els) this.els[id].style.transform = "";

    var seen = {};
    if (this.tree.root) {
      var rootEl = this.mount(this.tree.root, 0, seen);
      if (rootEl.parentNode !== this.stage) this.stage.append(rootEl);
    }

    for (id in this.els) {
      if (seen[id]) continue;
      el = this.els[id];
      delete this.els[id]; delete this.anims[id]; delete this.layout[id];
      var parent = el.parentElement;
      var parentKept = parent === this.stage || (parent && seen[parent.dataset.id]);
      if (parentKept) { el.remove(); if (first[id]) this.ghost(el, first[id]); }
    }

    this.fitToStage();

    var now = performance.now();
    var snap = document.hidden;
    for (id in this.els) {
      el = this.els[id];
      var to = rectOf(el);
      this.layout[id] = to;
      var from = first[id];
      if (from) {
        if (same(from, to)) delete this.anims[id];
        else this.anims[id] = { from: from, to: to, start: now };
      } else {
        var k = 0.7;
        this.anims[id] = {
          from: { x: to.x + (to.w * (1 - k)) / 2, y: to.y + (to.h * (1 - k)) / 2, w: to.w * k, h: to.h * k },
          to: to, start: now,
        };
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: 30, easing: "ease-out", fill: "backwards" });
      }
    }
    if (snap) this.anims = {};
    this.frame(now);
    this.flashChanged();
  };

  // One screen, never a scrollbar. When the tree is taller than the stage the
  // whole stage is zoomed down to fit (CSS zoom keeps layout and hit-testing
  // consistent, unlike transform). The fit factor is reported through onFit so
  // the server can tell the renderer its screen overflowed and needs cutting.
  Renderer.prototype.fitToStage = function () {
    var self = this;
    this.stage.style.zoom = "";
    if (!this.tree.root) { this.reportFit(1); return; }
    // How much taller than its slot is any container? No container scrolls
    // (overflow hidden everywhere), so each one's scrollHeight against its
    // clientHeight says how much its content wants beyond what it got. The
    // worst ratio in the tree is what the stage must zoom by.
    function overflowRatio() {
      var worst = 1;
      var walk = function (n) {
        if (!isContainer(n.type)) return;
        var el = self.els[n.id];
        if (el && el.clientHeight > 0) {
          var r = el.scrollHeight / el.clientHeight;
          if (r > worst) worst = r;
        }
        for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
      };
      walk(self.tree.root);
      return worst;
    }
    // A fill row's slot grows as the zoom drops, so the ratio is not the answer
    // by itself: bisect the zoom for the largest value with no overflow.
    var fits = function (z) { self.stage.style.zoom = z === 1 ? "" : String(z); return overflowRatio() <= 1.005; };
    var fit = 1;
    if (!fits(1)) {
      var lo = 0.4, hi = 1;
      if (fits(lo)) {
        for (var i = 0; i < 8; i++) {
          var mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid; else hi = mid;
        }
      }
      fit = lo;
      self.stage.style.zoom = String(fit);
    }
    this.reportFit(fit);
  };

  Renderer.prototype.reportFit = function (fit) {
    var rounded = Math.round(fit * 100) / 100;
    if (this.lastFit === rounded) return;
    this.lastFit = rounded;
    if (typeof this.onFit === "function") this.onFit(rounded);
  };

  // "What changed" highlight: every node whose content, type or source changed
  // in this commit, and every new node, gets a brief, faint border tint
  // (distinct from the model's `!` emphasis ring). Skipped on the first commit
  // after opening, where everything would be new. A parent whose only change is
  // a changed child does not flash; the child does. Keep in sync with the
  // .gl-fresh animation duration in src/html/styles/glyph.ts.
  var FRESH_MS = 1100;
  Renderer.prototype.flashChanged = function () {
    var changed = this.changed;
    this.changed = {};
    if (!this.everCommitted) { this.everCommitted = !!this.tree.root; return; }
    var self = this;
    Object.keys(changed).forEach(function (id) {
      var el = self.els[id];
      if (!el) return;
      if (self.freshTimers[id]) { clearTimeout(self.freshTimers[id]); el.classList.remove("gl-fresh"); void el.offsetWidth; }
      el.classList.add("gl-fresh");
      self.freshTimers[id] = setTimeout(function () { el.classList.remove("gl-fresh"); delete self.freshTimers[id]; }, FRESH_MS);
    });
  };

  Renderer.prototype.frame = function (now) {
    this.raf = 0;
    var world = {};
    var live = 0;
    for (var id in this.anims) {
      var a = this.anims[id];
      var t = (now - a.start) / DURATION;
      if (t >= 1) { delete this.anims[id]; continue; }
      live++;
      var p = easePos(t), s = easeSize(t);
      var sw = a.to.w >= a.from.w ? s : p;
      var sh = a.to.h >= a.from.h ? s : p;
      world[id] = {
        x: lerp(a.from.x, a.to.x, p), y: lerp(a.from.y, a.to.y, p),
        w: Math.max(1, lerp(a.from.w, a.to.w, sw)), h: Math.max(1, lerp(a.from.h, a.to.h, sh)),
      };
    }
    if (this.tree.root) this.place(this.tree.root, null, world);
    var self = this;
    if (live) this.raf = requestAnimationFrame(function (n) { self.frame(n); });
  };

  Renderer.prototype.place = function (node, parent, world) {
    var el = this.els[node.id];
    var L = this.layout[node.id];
    if (!el || !L) return;
    var W = world[node.id] || L;
    var sPx = 1, sPy = 1, ux = L.x, uy = L.y;
    if (parent) {
      sPx = Math.max(parent.W.w, 0.01) / Math.max(parent.L.w, 1);
      sPy = Math.max(parent.W.h, 0.01) / Math.max(parent.L.h, 1);
      ux = parent.W.x + (L.x - parent.L.x) * sPx;
      uy = parent.W.y + (L.y - parent.L.y) * sPy;
    }
    var sx = Math.max(W.w, 0.01) / (Math.max(L.w, 1) * sPx);
    var sy = Math.max(W.h, 0.01) / (Math.max(L.h, 1) * sPy);
    var tx = (W.x - ux) / sPx;
    var ty = (W.y - uy) / sPy;
    var identity = Math.abs(tx) < 0.02 && Math.abs(ty) < 0.02 && Math.abs(sx - 1) < 0.0005 && Math.abs(sy - 1) < 0.0005;
    el.style.transform = identity ? "" : "translate(" + tx + "px," + ty + "px) scale(" + sx + "," + sy + ")";
    for (var i = 0; i < node.children.length; i++) this.place(node.children[i], { L: L, W: W }, world);
  };

  /** Reload a web view (`#x` refresh op) after its file or artifact changed. */
  Renderer.prototype.refresh = function (id) {
    var el = this.els[id];
    if (!el) return;
    if (el.tagName === "IFRAME") {
      try { el.contentWindow.location.reload(); } catch (e) { el.src = el.src; }
    } else if (el.tagName === "IMG") {
      var u = el.getAttribute("src") || "";
      el.setAttribute("src", u.replace(/[?&]_r=\d+/, "") + (u.indexOf("?") === -1 ? "?" : "&") + "_r=" + Date.now());
    }
  };

  /** Apply a server payload {t, s, frame, refresh?}. Any failure resyncs from `frame`. */
  Renderer.prototype.apply = function (msg) {
    try {
      if (msg.t === "frame") {
        this.tree.load(!msg.s || msg.s.trim() === "" ? null : parseFrame(msg.s));
      } else {
        this.tree.applyOps(msg.s);
        if (msg.frame !== undefined && this.tree.serialize() !== msg.frame) {
          this.tree.load(msg.frame === "" ? null : parseFrame(msg.frame));
        }
      }
    } catch (e) {
      if (typeof msg.frame === "string") {
        try { this.tree.load(msg.frame === "" ? null : parseFrame(msg.frame)); } catch (e2) { console.error("[glyph] resync failed", e2); }
      } else {
        console.error("[glyph]", e);
      }
    }
    this.commit();
    if (msg.refresh && msg.refresh.length) for (var i = 0; i < msg.refresh.length; i++) this.refresh(msg.refresh[i]);
  };

  // ------------------------------------------------------------ overlay

  var overlay = {
    taskId: null,
    renderer: null,
    ws: null,
    reconnectTimer: null,
    closed: true,
    activeAgents: 0,
  };

  function el(id) { return document.getElementById(id); }

  function setStatus(text, kind) {
    var s = el("tc-glyph-status");
    if (!s) return;
    s.textContent = text || "";
    s.className = "tc-glyph__status" + (kind ? " tc-glyph__status--" + kind : "");
  }

  // Agent activity badge: pulsing dot + count while any agent instance runs on the task.
  function setAgents(n) {
    if (n > 0) setStatus(n === 1 ? "1 agent active" : n + " agents active", "busy");
    else setStatus("No agents active", "");
  }

  function setEmpty(show) {
    var e = el("tc-glyph-empty");
    if (e) e.hidden = !show;
  }

  function connect(taskId) {
    if (overlay.closed || overlay.taskId !== taskId) return;
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var sock = new WebSocket(proto + "://" + location.host + "/ws/ui?format=json&topics=glyph:" + encodeURIComponent(taskId));
    overlay.ws = sock;
    sock.addEventListener("message", function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.id !== taskId) return;
      if (msg.resource === "glyph" && msg.data) {
        overlay.renderer.apply(msg.data);
        setEmpty(!overlay.renderer.tree.root);
      } else if (msg.resource === "glyph:status" && msg.data) {
        // The slot shows agent activity; the renderer's own state only surfaces when it fails.
        if (msg.data.state === "error") setStatus(msg.data.error || "Renderer error", "error");
        else setAgents(overlay.activeAgents);
      } else if (msg.resource === "glyph:agents" && msg.data) {
        overlay.activeAgents = Number(msg.data.active) || 0;
        setAgents(overlay.activeAgents);
      }
    });
    sock.addEventListener("close", function () {
      if (overlay.ws === sock) overlay.ws = null;
      if (overlay.closed || overlay.taskId !== taskId) return;
      setStatus("Reconnecting", "error");
      overlay.reconnectTimer = setTimeout(function () { connect(taskId); }, 1500);
    });
    sock.addEventListener("error", function () { try { sock.close(); } catch (e) { /* ignore */ } });
  }

  function bootstrap(taskId) {
    fetch("/api/tasks/" + encodeURIComponent(taskId) + "/glyph/open", { method: "POST" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        if (!st || overlay.closed || overlay.taskId !== taskId) return;
        // A push may already have landed over the socket; only seed when the
        // stage is still empty so we never regress a newer frame.
        var seed = st.view || st.frame;
        if (!overlay.renderer.tree.root && seed) overlay.renderer.apply({ t: "frame", s: seed, frame: seed });
        setEmpty(!overlay.renderer.tree.root);
        overlay.activeAgents = Number(st.activeAgents) || 0;
        if (st.state === "error") setStatus(st.error || "Renderer error", "error");
        else setAgents(overlay.activeAgents);
      })
      .catch(function () { setStatus("Could not reach the server", "error"); });
  }

  var glyph = {
    open: function (taskId) {
      if (!taskId) return;
      var modal = el("tc-glyph-modal");
      var stage = el("tc-glyph-stage");
      var ghosts = el("tc-glyph-ghosts");
      if (!modal || !stage || !ghosts) return;
      if (!overlay.closed) glyph.close();
      overlay.closed = false;
      overlay.taskId = taskId;
      overlay.renderer = new Renderer(stage, ghosts);
      overlay.renderer.onFit = function (fit) {
        // Tell the renderer agent how much the screen had to shrink to fit.
        fetch("/api/tasks/" + encodeURIComponent(taskId) + "/glyph/viewport", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fit: fit }),
        }).catch(function () { /* advisory only */ });
      };
      setEmpty(true);
      setStatus("Connecting", "busy");
      if (window.Skipper && window.Skipper.modal) window.Skipper.modal.open("tc-glyph-modal");
      else modal.classList.add("sk-modal--open");
      connect(taskId);
      bootstrap(taskId);
    },
    close: function () {
      if (overlay.closed) return;
      overlay.closed = true;
      if (overlay.reconnectTimer) { clearTimeout(overlay.reconnectTimer); overlay.reconnectTimer = null; }
      if (overlay.ws) { try { overlay.ws.close(); } catch (e) { /* ignore */ } overlay.ws = null; }
      if (overlay.renderer) { overlay.renderer.destroy(); overlay.renderer = null; }
      overlay.taskId = null;
      var modal = el("tc-glyph-modal");
      if (modal && modal.classList.contains("sk-modal--open")) {
        if (window.Skipper && window.Skipper.modal) window.Skipper.modal.close("tc-glyph-modal");
        else modal.classList.remove("sk-modal--open");
      }
    },
    reset: function () {
      if (overlay.closed || !overlay.taskId) return;
      setStatus("Resetting", "busy");
      fetch("/api/tasks/" + encodeURIComponent(overlay.taskId) + "/glyph/reset", { method: "POST" })
        .catch(function () { setStatus("Could not reach the server", "error"); });
    },
    toggleIds: function () {
      var modal = el("tc-glyph-modal");
      if (modal) modal.classList.toggle("tc-glyph--ids");
    },
    // Exposed for debugging in the console.
    _protocol: { parseFrame: parseFrame, parseOps: parseOps, serializeNode: serializeNode, Tree: Tree },
  };

  // The generic modal close paths (backdrop click, Close button, Escape) only
  // toggle the class; watch for that so the socket is torn down too.
  document.addEventListener("click", function (e) {
    var modal = el("tc-glyph-modal");
    if (!modal || overlay.closed) return;
    var t = e.target;
    if (t.closest && (t.closest("[data-sk-modal-close='tc-glyph-modal']") || (t === modal && modal.hasAttribute("data-sk-modal-backdrop")))) {
      setTimeout(glyph.close, 0);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !overlay.closed) setTimeout(glyph.close, 0);
    if (e.key === "i" && !overlay.closed && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) glyph.toggleIds();
  });
  // HTMX navigation swaps #mc-main; if the task on screen changes the overlay is stale.
  document.addEventListener("htmx:pushedIntoHistory", function () { if (!overlay.closed) glyph.close(); });

  window.Skipper = window.Skipper || {};
  window.Skipper.glyph = glyph;
})(window, document);
