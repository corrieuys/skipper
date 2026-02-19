/**
 * Monkey Pet — self-contained frontend module.
 * Pixel art monkey that lives in the UI, driven by Haiku brain via WebSocket.
 */
(function () {
  "use strict";

  // --- SPRITE SYSTEM — grid-based pixel art, 16x16 ---
  // Greg has three personas (driven by the brain): monkey, parrot, penguin.
  // Each is a 16x16 grid + palette. All share the same silhouette footprint
  // (feet on row 14) so perch / jump / slide positioning is identical.
  const S = 16;
  const SCALE = 4.8;
  const RENDERED_SIZE = S * SCALE;

  function spriteFromGrid(grid, palette) {
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = false;
    for (let r = 0; r < S; r++) {
      for (let col = 0; col < S; col++) {
        const color = palette[grid[r * S + col]];
        if (color) { x.fillStyle = color; x.fillRect(col, r, 1, 1); }
      }
    }
    return c;
  }
  const R = (r, c) => r * S + c;
  function gmod(base, changes) {
    const g = base.slice();
    for (const [i, v] of changes) g[i] = v;
    return g;
  }

  // Build the five animation states from an idle grid + small per-character
  // pixel mods (blink / walk phases / talk / jump-tuck).
  function buildFrames(palette, idle, mods) {
    const s = (g) => spriteFromGrid(g, palette);
    const I = s(idle);
    const blink = s(gmod(idle, mods.blink));
    const w1 = s(gmod(idle, mods.walk1));
    const w2 = s(gmod(idle, mods.walk2));
    const talk = s(gmod(idle, mods.talk));
    const jump = s(gmod(idle, mods.jump));
    return {
      idle: [I, I, I, I, I, I, I, I, I, I, I, I, I, I, blink],
      walking: [w1, w2],
      jumping: [jump],
      sliding: [jump],
      talking: [talk, I],
    };
  }

  // ── MONKEY — brown fur, tan face/belly, side ears, two eyes ──
  // 0=transparent 1=outline 2=fur 3=tan(face/belly) 4=eyes 6=ear-inner
  const MONKEY_PALETTE = { 0: null, 1: "#3a2416", 2: "#8a5a34", 3: "#e8c79a", 4: "#241712", 6: "#b07f4f" };
  const MONKEY_IDLE = [
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0,
    0,1,6,6,1,1,2,2,2,2,1,1,6,6,1,0,
    0,1,6,6,1,2,2,2,2,2,2,1,6,6,1,0,
    0,0,1,1,2,3,3,3,3,3,3,2,1,1,0,0,
    0,0,0,1,2,3,4,3,3,4,3,2,1,0,0,0,
    0,0,0,1,2,3,3,3,3,3,3,2,1,0,0,0,
    0,0,0,1,2,3,3,1,1,3,3,2,1,0,0,0,
    0,0,0,0,1,2,3,3,3,3,2,1,0,0,0,0,
    0,0,0,0,1,2,2,2,2,2,2,1,0,0,0,0,
    0,0,0,1,2,2,3,3,3,3,2,2,1,0,0,0,
    0,0,0,1,2,2,3,3,3,3,2,2,1,0,0,0,
    0,0,0,1,2,2,2,2,2,2,2,2,1,0,0,0,
    0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0,
    0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  ];
  const MONKEY_FRAMES = buildFrames(MONKEY_PALETTE, MONKEY_IDLE, {
    blink: [[R(5, 6), 3], [R(5, 9), 3]],
    walk1: [[R(14, 4), 0], [R(14, 3), 1], [R(14, 5), 1], [R(14, 6), 1], [R(14, 9), 1], [R(14, 10), 1], [R(14, 11), 1], [R(14, 12), 1]],
    walk2: [[R(14, 4), 0], [R(14, 5), 1], [R(14, 6), 1], [R(14, 9), 1], [R(14, 10), 1], [R(14, 11), 0]],
    talk:  [[R(7, 6), 1], [R(7, 7), 1], [R(7, 8), 1], [R(7, 9), 1], [R(8, 6), 1], [R(8, 7), 3], [R(8, 8), 3], [R(8, 9), 1]],
    jump:  [[R(13, 4), 1], [R(13, 5), 2], [R(13, 6), 2], [R(13, 7), 2], [R(13, 8), 2], [R(13, 9), 2], [R(13, 10), 2], [R(13, 11), 1], [R(14, 4), 0], [R(14, 7), 0], [R(14, 11), 0]],
  });

  // ── PARROT — green body, yellow belly, orange beak/feet, red wings ──
  // 1=outline 2=green 3=yellow 4=eye 5=orange(beak/feet) 6=red(wing)
  const PARROT_PALETTE = { 0: null, 1: "#1f3d22", 2: "#3fae4f", 3: "#f2d34a", 4: "#15110a", 5: "#ff9b1a", 6: "#e0563f" };
  const PARROT_IDLE = [
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,
    0,0,0,0,1,2,2,2,2,1,0,0,0,0,0,0,
    0,0,0,1,2,2,2,2,2,2,1,0,0,0,0,0,
    0,0,0,1,2,4,2,2,4,2,1,0,0,0,0,0,
    0,0,0,1,2,2,5,5,2,2,1,0,0,0,0,0,
    0,0,0,0,1,2,5,5,2,1,0,0,0,0,0,0,
    0,0,0,0,1,2,2,2,2,1,0,0,0,0,0,0,
    0,0,0,0,1,2,3,3,3,3,2,1,0,0,0,0,
    0,0,0,0,1,6,2,2,2,2,6,1,0,0,0,0,
    0,0,0,1,6,2,3,3,3,3,2,6,1,0,0,0,
    0,0,0,1,2,2,3,3,3,3,2,2,1,0,0,0,
    0,0,0,1,2,2,2,2,2,2,2,2,1,0,0,0,
    0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0,
    0,0,0,0,5,5,5,0,0,5,5,5,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  ];
  const BIRD_MODS = {
    walk1: [[R(14, 4), 0], [R(14, 6), 0], [R(14, 9), 0], [R(14, 11), 0]],
    walk2: [[R(14, 5), 0], [R(14, 10), 0]],
    jump:  [[R(14, 4), 0], [R(14, 5), 0], [R(14, 6), 0], [R(14, 9), 0], [R(14, 10), 0], [R(14, 11), 0]],
  };
  const PARROT_FRAMES = buildFrames(PARROT_PALETTE, PARROT_IDLE, {
    blink: [[R(4, 5), 2], [R(4, 8), 2]],
    talk:  [[R(6, 6), 1], [R(6, 7), 1]],
    ...BIRD_MODS,
  });

  // ── PENGUIN — dark body, white belly/face, orange beak/feet ──
  // 1=outline 2=body 3=white(belly/face) 4=eye 5=orange(beak/feet)
  const PENGUIN_PALETTE = { 0: null, 1: "#15171c", 2: "#2b2f38", 3: "#f2f4f8", 4: "#0a0c10", 5: "#ff9b1a" };
  const PENGUIN_IDLE = [
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,
    0,0,0,0,1,2,2,2,2,1,0,0,0,0,0,0,
    0,0,0,1,2,3,3,3,3,2,1,0,0,0,0,0,
    0,0,0,1,2,4,3,3,4,2,1,0,0,0,0,0,
    0,0,0,1,2,3,5,5,3,2,1,0,0,0,0,0,
    0,0,0,0,1,2,3,3,2,1,0,0,0,0,0,0,
    0,0,0,0,1,2,2,2,2,1,0,0,0,0,0,0,
    0,0,0,0,1,2,3,3,3,3,2,1,0,0,0,0,
    0,0,0,0,1,2,3,3,3,3,2,1,0,0,0,0,
    0,0,0,1,2,2,3,3,3,3,2,2,1,0,0,0,
    0,0,0,1,2,2,3,3,3,3,2,2,1,0,0,0,
    0,0,0,1,2,2,3,3,3,3,2,2,1,0,0,0,
    0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0,
    0,0,0,0,5,5,5,0,0,5,5,5,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  ];
  const PENGUIN_FRAMES = buildFrames(PENGUIN_PALETTE, PENGUIN_IDLE, {
    blink: [[R(4, 5), 3], [R(4, 8), 3]],
    talk:  [[R(6, 6), 5], [R(6, 7), 5]],
    ...BIRD_MODS,
  });

  const CHARACTERS = { monkey: MONKEY_FRAMES, parrot: PARROT_FRAMES, penguin: PENGUIN_FRAMES };
  const DEFAULT_CHARACTER = "monkey";


  // --- DOM SCANNER ---
  const NAV_HEIGHT = 52;

  // Where greg's center goes to sit with his feet on an element's top edge.
  function perchCenter(rect) {
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.max(NAV_HEIGHT, Math.round(rect.top - RENDERED_SIZE / 2 + 6)),
    };
  }

  function scanPerches() {
    // Greg only perches on buttons and on the TOP edge of container divs —
    // never on list items (activity rows, tree nodes, tabs, badges, dots).
    const perches = [];
    const seen = new Set();
    const selectors = [
      { sel: ".sk-btn, button", type: "button" },
      { sel: "input, textarea", type: "input" },
      { sel: ".sk-panel, .sk-card, .mc-task-header, .mc-outputs, #dashboard-latest-steer", type: "container" },
    ];

    let idx = 0;
    for (const { sel, type } of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        if (el.id === "monkey-reply-input") return; // never perch on greg's own box
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.top < NAV_HEIGHT) return;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        if (rect.right < 0 || rect.left > window.innerWidth) return;
        seen.add(el);
        const { x, y } = perchCenter(rect);
        const perch = {
          id: `${type}-${idx++}`,
          label: (el.textContent || "").trim().slice(0, 25),
          type,
          x,
          y,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        // Keep the live element so greg can stay pinned to it on scroll, but
        // non-enumerable so JSON.stringify (the perch payload to the brain)
        // skips it — a DOM node would otherwise throw on serialization.
        Object.defineProperty(perch, "el", { value: el, enumerable: false });
        perches.push(perch);
      });
    }

    // Sidebar bottom — the landing spot at the base of the slide
    for (const sel of SLIDE_EDGE_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const bottomY = Math.round(r.bottom - RENDERED_SIZE / 2);
      const x = Math.max(RENDERED_SIZE / 2, Math.min(Math.round(r.right), window.innerWidth - RENDERED_SIZE / 2));
      if (bottomY > NAV_HEIGHT && bottomY < window.innerHeight) {
        const perch = {
          id: "sidebar-base",
          label: "sidebar base",
          type: "container",
          x,
          y: bottomY,
          width: Math.round(r.width),
          height: RENDERED_SIZE,
        };
        Object.defineProperty(perch, "el", { value: el, enumerable: false });
        perches.push(perch);
      }
    }

    return perches;
  }

  function scanDOMMap() {
    const sections = [];
    // Major page sections grug can navigate between
    const sectionSelectors = [
      { sel: ".mc-chat-panel", type: "chat-panel" },
      { sel: "#mc-main", type: "main-content" },
      { sel: ".mc-sidebar", type: "sidebar" },
      { sel: "#sk-agent-tree", type: "agent-tree" },
      { sel: ".mc-activity__feed", type: "activity-feed" },
      { sel: "[data-sk-output-panel='notes']", type: "notes-panel" },
      { sel: "[data-sk-output-panel='artifacts']", type: "artifacts-panel" },
      { sel: "[id^='mc-steer-']", type: "steer-panel" },
      { sel: ".mc-phase-stepper", type: "phase-stepper" },
      { sel: ".mc-task-header", type: "task-header" },
      { sel: ".sk-panel", type: "panel" },
      { sel: ".mc-outputs", type: "outputs" },
      { sel: ".sk-card", type: "card" },
    ];

    const seen = new Set();

    for (const { sel, type } of sectionSelectors) {
      const els = document.querySelectorAll(sel);
      els.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.top < NAV_HEIGHT) return;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        if (rect.right < 0 || rect.left > window.innerWidth) return;

        const sectionId = el.id || `${type}-${i}`;
        if (seen.has(sectionId)) return;
        seen.add(sectionId);

        // Get readable content (text, trimmed)
        const content = getReadableContent(el);

        // Get interactive children
        const children = [];
        const childEls = el.querySelectorAll("button, a, .sk-btn, .sk-badge, input, .sk-tree__node, .mc-activity__item, .mc-phase-step__dot");
        childEls.forEach((child, ci) => {
          if (ci >= 8) return; // cap children per section
          const cr = child.getBoundingClientRect();
          if (cr.width === 0 || cr.height === 0) return;
          const childLabel = (child.textContent || "").trim().slice(0, 30);
          if (!childLabel) return;
          children.push({
            id: `${sectionId}-child-${ci}`,
            tag: child.tagName.toLowerCase(),
            type: child.classList.contains("sk-badge") ? "badge" :
                  child.classList.contains("sk-tree__node") ? "agent-node" :
                  child.classList.contains("mc-activity__item") ? "activity" :
                  child.tagName === "BUTTON" || child.classList.contains("sk-btn") ? "button" :
                  child.tagName === "A" ? "link" :
                  child.tagName === "INPUT" ? "input" : "element",
            label: childLabel,
            x: Math.round(cr.left + cr.width / 2),
            y: Math.round(cr.top),
          });
        });

        sections.push({
          id: sectionId,
          label: getSectionLabel(el, type),
          type,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + 30),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          content,
          children,
        });
      });
    }
    return sections;
  }

  function getReadableContent(el) {
    // Get meaningful text from element, skip scripts/styles, cap length
    const clone = el.cloneNode(true);
    clone.querySelectorAll("script, style, svg, canvas").forEach(n => n.remove());
    let text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 300);
  }

  function getSectionLabel(el, type) {
    // Try to find a heading or title within the section
    const heading = el.querySelector("h1, h2, h3, h4, .sk-panel__title, .mc-task-header__title");
    if (heading) return (heading.textContent || "").trim().slice(0, 40);
    if (el.id) return el.id;
    return type;
  }

  // --- SLIDE EDGES ---
  // Vertical edges greg can slide down. Add more selectors here later.
  const SLIDE_EDGE_SELECTORS = [".mc-sidebar"];

  function findSlideEdges() {
    const half = RENDERED_SIZE / 2;
    const edges = [];
    for (const sel of SLIDE_EDGE_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const topY = Math.round(r.top + half + 6);
      const bottomY = Math.round(r.bottom - half);
      if (bottomY - topY < 60) continue; // too short to bother
      const x = Math.max(half, Math.min(Math.round(r.right), window.innerWidth - half));
      edges.push({ x, topY, bottomY });
    }
    return edges;
  }

  function findSlideEdge() {
    const edges = findSlideEdges();
    return edges.length ? edges[Math.floor(Math.random() * edges.length)] : null;
  }

  // --- MONKEY RENDERER ---
  class MonkeyRenderer {
    constructor() {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "monkey-pet-canvas";
      this.canvas.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 9999;
      `;
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
      document.body.appendChild(this.canvas);

      this.ctx = this.canvas.getContext("2d");
      this.ctx.imageSmoothingEnabled = false;

      // Spawn bottom-left, in the sidebar area at the bottom of the window.
      this.state = {
        x: RENDERED_SIZE / 2 + 24,
        y: window.innerHeight - RENDERED_SIZE / 2,
        animation: "idle",
        facing: "right",
      };
      this.frameIndex = 0;
      this.frameTick = 0;
      this.character = DEFAULT_CHARACTER;     // monkey | parrot | penguin
      this.frames = CHARACTERS[DEFAULT_CHARACTER];
      this.speechBubble = null;
      this.speechHistory = [];
      this.historyVisible = false;
      this.targetPos = null;
      this.moving = false;
      this.jumpProgress = 0;
      this.jumpStartPos = null;
      this.landingTimer = 0;
      this.talkingTicks = 0;
      this.slide = null;
      this.perchEl = null;        // element greg is currently resting on (pinned)
      this.pendingPerchEl = null; // element a jump is heading toward
      this.currentFocusEl = null; // text field the user is in (for "focus" jumps)
      this.squashScale = { x: 1, y: 1 };
      this.ws = null;

      // Clickable hitbox that follows the monkey
      this.hitbox = document.createElement("div");
      this.hitbox.id = "monkey-hitbox";
      this.hitbox.style.cssText = `
        position: fixed;
        width: ${RENDERED_SIZE}px;
        height: ${RENDERED_SIZE}px;
        cursor: pointer;
        z-index: 10000;
        border-radius: 50%;
      `;
      this.hitbox.title = "Click: hop · Double-click: chat · Drag: move";
      document.body.appendChild(this.hitbox);

      // Drag + click/dblclick support
      this._dragging = false;
      this._dragStartPos = null;
      this._didDrag = false;
      this._clickTimer = null;

      this.hitbox.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._dragging = true;
        this._didDrag = false;
        this._dragStartPos = { x: e.clientX, y: e.clientY };
        this.hitbox.style.cursor = "grabbing";
        this.moving = false;
        this.targetPos = null;
        this.perchEl = null; // dragging detaches him from any perch
      });

      document.addEventListener("mousemove", (e) => {
        if (!this._dragging) return;
        const dx = e.clientX - this._dragStartPos.x;
        const dy = e.clientY - this._dragStartPos.y;
        if (!this._didDrag && Math.abs(dx) + Math.abs(dy) > 5) {
          this._didDrag = true;
        }
        if (this._didDrag) {
          this.state.x = e.clientX;
          this.state.y = e.clientY;
          this.state.animation = "idle";
        }
      });

      document.addEventListener("mouseup", () => {
        if (!this._dragging) return;
        this._dragging = false;
        this.hitbox.style.cursor = "pointer";
        if (!this._didDrag) {
          // Single click = a quick hop (or occasional slide). Delayed so a
          // double-click can cancel it before it fires.
          if (this._clickTimer) clearTimeout(this._clickTimer);
          this._clickTimer = setTimeout(() => {
            this._clickTimer = null;
            this.doClickMove();
          }, 250);
        }
      });

      // Combined "previous chats" + reply popup (opened on double-click)
      this.historyBox = document.createElement("div");
      this.historyBox.id = "monkey-history";
      this.historyBox.style.cssText = `
        position: fixed;
        display: none;
        z-index: 10001;
        background: rgba(0,0,0,0.95);
        border: 1px solid #b0ff96;
        border-radius: 8px;
        padding: 10px;
        width: 300px;
        font: 12px monospace;
        color: #b0ff96;
      `;
      this.historyBox.innerHTML = `
        <div id="monkey-history-list" style="max-height:200px;overflow-y:auto;"></div>
        <input type="text" id="monkey-reply-input" placeholder="reply to greg..." maxlength="60"
          style="margin-top:8px;background:rgba(176,255,150,0.08);border:1px solid rgba(176,255,150,0.3);border-radius:4px;color:#b0ff96;font:bold 13px monospace;width:100%;outline:none;padding:5px;box-sizing:border-box;">
      `;
      document.body.appendChild(this.historyBox);

      this.hitbox.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
        this.toggleHistory();
      });

      // Submit reply on Enter (input lives inside the history popup)
      this.historyBox.querySelector("#monkey-reply-input").addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && e.target.value.trim()) {
          this.submitReply(e.target.value.trim());
          e.target.value = "";
        }
        if (e.key === "Escape") {
          this.toggleHistory(false);
        }
      });

      // Close the popup when clicking elsewhere
      document.addEventListener("click", (e) => {
        if (this.historyVisible && !this.historyBox.contains(e.target) && e.target !== this.hitbox) {
          this.toggleHistory(false);
        }
      });

      window.addEventListener("resize", () => {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
      });

      this.animate();
    }

    animate() {
      this.frameTick++;
      if (this.frameTick % 8 === 0) {
        const frames = this.frames[this.state.animation] || this.frames.idle;
        this.frameIndex = (this.frameIndex + 1) % frames.length;
      }

      // Talking animation auto-expires back to idle after a short while
      if (this.talkingTicks > 0) {
        this.talkingTicks--;
        if (this.talkingTicks === 0 && this.state.animation === "talking" && !this.moving) {
          this.state.animation = "idle";
        }
      }

      // Landing squash animation
      if (this.landingTimer > 0) {
        this.landingTimer--;
        const t = this.landingTimer / 12;
        const bounce = Math.sin(t * Math.PI * 2) * t;
        this.squashScale.x = 1 + bounce * 0.3;
        this.squashScale.y = 1 - bounce * 0.2;
        if (this.landingTimer === 0) {
          this.squashScale = { x: 1, y: 1 };
        }
      }

      // Move toward target
      if (this.targetPos && this.moving) {
        if (this.state.animation === "jumping" && this.jumpStartPos) {
          // Parabolic jump arc
          this.jumpProgress = Math.min(1, this.jumpProgress + 0.025);
          const t = this.jumpProgress;
          const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          this.state.x = this.jumpStartPos.x + (this.targetPos.x - this.jumpStartPos.x) * ease;
          const baseY = this.jumpStartPos.y + (this.targetPos.y - this.jumpStartPos.y) * ease;
          const totalDist = Math.sqrt(
            Math.pow(this.targetPos.x - this.jumpStartPos.x, 2) +
            Math.pow(this.targetPos.y - this.jumpStartPos.y, 2)
          );
          const arcHeight = Math.max(50, Math.min(120, totalDist * 0.4));
          this.state.y = baseY - Math.sin(t * Math.PI) * arcHeight;
          this.state.facing = this.targetPos.x > this.jumpStartPos.x ? "right" : "left";

          if (t >= 1) {
            this.moving = false;
            this.state.x = this.targetPos.x;
            this.state.y = this.targetPos.y;
            this.jumpStartPos = null;
            this.jumpProgress = 0;
            if (this.slide && this.slide.phase === "toTop") {
              // Landed at the top of the edge — now slide down it.
              this.slide.phase = "down";
              this.state.animation = "sliding";
              this.state.facing = "left";
              this.targetPos = { x: this.slide.edge.x, y: this.slide.edge.bottomY };
              this.moving = true;
            } else {
              this.landingTimer = 12;
              this.state.animation = "idle";
              // Pin to whatever element this jump landed on (if any) so greg
              // tracks it on scroll until he moves again.
              this.perchEl = this.pendingPerchEl || null;
              this.pendingPerchEl = null;
            }
          }
        } else if (this.state.animation === "sliding" && this.slide) {
          // Slide straight down the edge at a steady speed.
          this.state.x = this.slide.edge.x;
          this.state.facing = "left";
          const remaining = this.slide.edge.bottomY - this.state.y;
          if (remaining > 5) {
            this.state.y += Math.min(7, remaining);
          } else {
            // Reached the base of the slide — rest here as a perch. Don't
            // immediately bounce off; that reads as erratic.
            this.state.y = this.slide.edge.bottomY;
            this.slide = null;
            this.moving = false;
            this.landingTimer = 12;
            this.state.animation = "idle";
          }
        } else {
          // Walking / climbing with easing
          const dx = this.targetPos.x - this.state.x;
          const dy = this.targetPos.y - this.state.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 3) {
            const baseSpeed = 3;
            const ease = Math.max(0.3, Math.min(1, dist / 80));
            const speed = baseSpeed * ease;
            this.state.x += (dx / dist) * speed;
            this.state.y += (dy / dist) * speed;
            this.state.facing = dx > 0 ? "right" : "left";
          } else {
            this.moving = false;
            this.state.x = this.targetPos.x;
            this.state.y = this.targetPos.y;
            this.landingTimer = 8;
            this.state.animation = "idle";
          }
        }
      }

      // Stay pinned to the perch element while at rest, so scrolling / layout
      // shifts keep greg sitting in the right spot until he moves again.
      if (this.perchEl && !this.moving && !this._dragging) {
        const rect = this.perchEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          this.perchEl = null; // element gone — unpin, stay put
        } else {
          const c = perchCenter(rect);
          this.state.x = c.x;
          this.state.y = c.y;
        }
      }

      // Clamp position so monkey stays fully visible
      const half = RENDERED_SIZE / 2;
      const minY = half + 52; // below navbar (~48px + margin)
      const maxY = this.canvas.height - half;
      const minX = half;
      const maxX = this.canvas.width - half;
      this.state.x = Math.max(minX, Math.min(maxX, this.state.x));
      this.state.y = Math.max(minY, Math.min(maxY, this.state.y));

      this.render();
      requestAnimationFrame(() => this.animate());
    }

    render() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      const frames = this.frames[this.state.animation] || this.frames.idle;
      const frame = frames[this.frameIndex % frames.length];

      const x = Math.round(this.state.x - RENDERED_SIZE / 2);
      const y = Math.round(this.state.y - RENDERED_SIZE / 2);

      const cx = x + RENDERED_SIZE / 2;
      const cy = y + RENDERED_SIZE / 2;

      this.ctx.save();
      this.ctx.translate(cx, cy);
      this.ctx.scale(
        this.squashScale.x * (this.state.facing === "left" ? -1 : 1),
        this.squashScale.y
      );
      this.ctx.drawImage(frame, -RENDERED_SIZE / 2, -RENDERED_SIZE / 2, RENDERED_SIZE, RENDERED_SIZE);
      this.ctx.restore();

      // Speech bubble — persists until Greg's NEXT utterance replaces it
      // (or the user replies, which clears it in submitReply). No timer.
      if (this.speechBubble) {
        this.renderSpeechBubble(x, y);
      }

      // Update clickable hitbox position
      this.updateHitbox();
    }

    renderSpeechBubble(mx, my) {
      const text = this.speechBubble.text;
      this.ctx.font = "bold 13px monospace";
      const padding = 8;
      const lineHeight = 16;
      const maxTextWidth = 200;

      // Word-wrap into lines that fit maxTextWidth
      const words = text.split(" ");
      const lines = [];
      let current = "";
      for (const word of words) {
        const candidate = current ? current + " " + word : word;
        if (this.ctx.measureText(candidate).width > maxTextWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) lines.push(current);

      const textWidth = Math.max(...lines.map((l) => this.ctx.measureText(l).width));
      const bw = textWidth + padding * 2;
      const bh = lines.length * lineHeight + padding * 2;
      const cw = this.canvas.width;
      const ch = this.canvas.height;

      // Collect rects of active input fields to avoid covering them
      const avoidRects = [];
      if (this.currentFocusEl) {
        const r = this.currentFocusEl.getBoundingClientRect();
        if (r.width && r.height) avoidRects.push(r);
      }

      // Also avoid the greg reply input if visible
      const replyInput = document.getElementById("monkey-reply-input");
      if (replyInput) {
        const histBox = document.getElementById("monkey-history");
        if (histBox && histBox.style.display !== "none") {
          const r = histBox.getBoundingClientRect();
          if (r.width && r.height) avoidRects.push(r);
        }
      }

      // Test if a candidate bubble rect overlaps any avoid rect
      const overlaps = (bx, by) => {
        for (const r of avoidRects) {
          if (bx < r.right && bx + bw > r.left && by < r.bottom && by + bh > r.top) return true;
        }
        return false;
      };

      // Try four positions: right, left, above, below
      const candidates = [
        { bx: mx + RENDERED_SIZE + 8, by: my - 14, side: "right" },
        { bx: mx - bw - 8, by: my - 14, side: "left" },
        { bx: mx - bw / 2 + RENDERED_SIZE / 2, by: my - bh - 12, side: "above" },
        { bx: mx - bw / 2 + RENDERED_SIZE / 2, by: my + RENDERED_SIZE + 8, side: "below" },
      ];

      let chosen = candidates[0];
      for (const c of candidates) {
        // Check on-screen and not overlapping input fields
        if (c.bx >= 4 && c.bx + bw <= cw - 4 && c.by >= 4 && c.by + bh <= ch - 4 && !overlaps(c.bx, c.by)) {
          chosen = c;
          break;
        }
      }
      // Fallback: pick first that's on-screen even if it overlaps
      if (overlaps(chosen.bx, chosen.by)) {
        for (const c of candidates) {
          if (c.bx >= 4 && c.bx + bw <= cw - 4 && c.by >= 4 && c.by + bh <= ch - 4) {
            chosen = c;
            break;
          }
        }
      }

      // Clamp to canvas bounds
      const bx = Math.max(4, Math.min(chosen.bx, cw - bw - 4));
      const by = Math.max(4, Math.min(chosen.by, ch - bh - 4));
      const side = chosen.side;

      // Bubble background with border
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
      this.ctx.strokeStyle = "#b0ff96";
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.roundRect(bx, by, bw, bh, 6);
      this.ctx.fill();
      this.ctx.stroke();

      // Pointer triangle
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
      this.ctx.beginPath();
      if (side === "left") {
        this.ctx.moveTo(bx + bw, by + bh / 2 - 4);
        this.ctx.lineTo(bx + bw + 6, by + bh / 2);
        this.ctx.lineTo(bx + bw, by + bh / 2 + 4);
      } else if (side === "above") {
        this.ctx.moveTo(bx + bw / 2 - 4, by + bh);
        this.ctx.lineTo(bx + bw / 2, by + bh + 6);
        this.ctx.lineTo(bx + bw / 2 + 4, by + bh);
      } else if (side === "below") {
        this.ctx.moveTo(bx + bw / 2 - 4, by);
        this.ctx.lineTo(bx + bw / 2, by - 6);
        this.ctx.lineTo(bx + bw / 2 + 4, by);
      } else {
        this.ctx.moveTo(bx, by + bh / 2 - 4);
        this.ctx.lineTo(bx - 6, by + bh / 2);
        this.ctx.lineTo(bx, by + bh / 2 + 4);
      }
      this.ctx.fill();

      // Text — one line per wrapped row
      this.ctx.fillStyle = "#b0ff96";
      this.ctx.textBaseline = "top";
      for (let i = 0; i < lines.length; i++) {
        this.ctx.fillText(lines[i], bx + padding, by + padding + i * lineHeight);
      }
    }

    executeCommand(action) {
      const perches = scanPerches();
      const sayText = typeof action.text === "string" ? action.text.trim() : "";

      switch (action.type) {
        case "walk":
          // Moving detaches him from his perch (say/idle keep him pinned).
          this.perchEl = null;
          this.pendingPerchEl = null;
          this.state.animation = "walking";
          this.state.facing = action.direction;
          const walkDist = action.steps * 30;
          this.targetPos = {
            x: this.state.x + (action.direction === "right" ? walkDist : -walkDist),
            y: this.state.y,
          };
          this.moving = true;
          break;

        case "jump": {
          this.perchEl = null;
          this.pendingPerchEl = null;
          this.state.animation = "jumping";
          this.jumpStartPos = { x: this.state.x, y: this.state.y };
          this.jumpProgress = 0;
          // "focus" / "field" = leap to the field the user is typing in.
          let jumpTarget = null;
          if (action.target === "focus" || action.target === "field") {
            jumpTarget = this.nearestPerchToEl(this.currentFocusEl);
          }
          if (!jumpTarget) jumpTarget = perches.find(p => p.id === action.target);
          if (jumpTarget) {
            this.targetPos = { x: jumpTarget.x, y: jumpTarget.y };
            this.pendingPerchEl = jumpTarget.el || null;
          } else if (perches.length > 0) {
            const rp = perches[Math.floor(Math.random() * perches.length)];
            this.targetPos = { x: rp.x, y: rp.y };
            this.pendingPerchEl = rp.el || null;
          } else {
            // No perch to leap to — hop in place so the jump still animates
            // instead of freezing (the arc only runs when targetPos is set).
            this.targetPos = { x: this.state.x, y: this.state.y };
          }
          this.moving = true;
          break;
        }

        case "slide": {
          this.perchEl = null;
          this.pendingPerchEl = null;
          const edge = findSlideEdge();
          if (!edge) {
            // Nowhere to slide right now — just stand.
            this.state.animation = "idle";
            this.moving = false;
            break;
          }
          // Jump to the top of the edge; the animate loop slides down from there.
          this.slide = { phase: "toTop", edge };
          this.state.animation = "jumping";
          this.jumpStartPos = { x: this.state.x, y: this.state.y };
          this.jumpProgress = 0;
          this.targetPos = { x: edge.x, y: edge.topY };
          this.moving = true;
          break;
        }

        case "idle":
          this.moving = false;
          if (sayText) {
            // idle + words = stand and talk.
            this.showSpeech(sayText);
            this.state.animation = "talking";
            this.talkingTicks = Math.min(150, 50 + sayText.length * 2);
          } else {
            this.state.animation = "idle";
          }
          break;

        case "say":
          this.showSpeech(action.text);
          // Play the talking animation briefly, then revert to idle. Duration
          // scales with text length (~60fps): short quips ~1s, long lines ~2.5s.
          if (!this.moving) {
            this.state.animation = "talking";
            this.talkingTicks = Math.min(150, 50 + (action.text || "").length * 2);
          }
          break;
      }

      // Move + speech in one breath: show the bubble while the move animation
      // plays (the movement frames stay; the bubble is independent).
      if (sayText && (action.type === "walk" || action.type === "jump" || action.type === "slide")) {
        this.showSpeech(sayText);
      }
    }

    showSpeech(text) {
      this.speechBubble = { text };
      this.speechHistory.unshift({ text, time: Date.now() });
      if (this.speechHistory.length > 20) this.speechHistory.length = 20;
    }

    updateState(serverState) {
      // Don't override position mid-animation, and don't cut short an active
      // talking burst that a just-processed "say" started.
      const talkingActive = this.state.animation === "talking" && this.talkingTicks > 0;
      if (!this.moving && !talkingActive) {
        this.state.animation = serverState.animation || this.state.animation;
        this.state.facing = serverState.facing || this.state.facing;
        // A pushed "talking" state should also be brief, not permanent.
        if (this.state.animation === "talking" && this.talkingTicks === 0) {
          this.talkingTicks = 90;
        }
      } else if (!this.moving && serverState.facing) {
        this.state.facing = serverState.facing;
      }
    }

    setWs(ws) {
      this.ws = ws;
    }

    // Swap the rendered persona (monkey | parrot | penguin). Footprint is shared
    // across characters, so position/perch state is untouched.
    setCharacter(id) {
      const frames = CHARACTERS[id];
      if (!frames || id === this.character) return;
      this.character = id;
      this.frames = frames;
      this.frameIndex = 0;
    }

    setVisible(visible) {
      const display = visible ? "" : "none";
      this.canvas.style.display = display;
      this.hitbox.style.display = display;
      if (!visible) {
        this.toggleHistory(false);
      }
    }

    toggleHistory(force) {
      this.historyVisible = force !== undefined ? force : !this.historyVisible;
      if (this.historyVisible) {
        const list = this.historyBox.querySelector("#monkey-history-list");
        const items = this.speechHistory.slice(0, 8);
        if (items.length === 0) {
          list.innerHTML = `<div style="opacity:0.5;">greg hasn't said anything yet</div>`;
        } else {
          list.innerHTML = items.map((s, i) => {
            const ago = Math.round((Date.now() - s.time) / 1000);
            const timeStr = ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`;
            return `<div style="padding:3px 0;${i > 0 ? "border-top:1px solid rgba(176,255,150,0.15);margin-top:3px;" : ""}">
              <span style="opacity:0.4;font-size:10px;">${timeStr}</span> ${s.text}
            </div>`;
          }).join("");
        }
        const x = Math.round(this.state.x);
        const y = Math.round(this.state.y - RENDERED_SIZE - 10);
        this.historyBox.style.left = Math.max(10, Math.min(x - 150, window.innerWidth - 320)) + "px";
        this.historyBox.style.top = Math.max(10, y - 130) + "px";
        this.historyBox.style.display = "block";
        setTimeout(() => this.historyBox.querySelector("#monkey-reply-input").focus(), 50);
      } else {
        this.historyBox.style.display = "none";
      }
    }

    doClickMove() {
      this.executeCommand({ type: "jump", target: "__click__" });
    }

    // Perch nearest the field the user is typing in — used when the brain
    // decides to jump with target "focus". Returns null if no field/perch.
    nearestPerchToEl(el) {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const perches = scanPerches();
      if (!perches.length) return null;
      const fx = rect.left + rect.width / 2;
      const fy = rect.top;
      let best = null;
      let bestD = Infinity;
      for (const p of perches) {
        const d = Math.hypot(p.x - fx, p.y - fy);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    }

    submitReply(text) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const lastSaid = this.speechBubble ? this.speechBubble.text : "";
        this.ws.send(JSON.stringify({
          type: "user_reply",
          reply: text,
          context: lastSaid,
        }));
        this.speechBubble = null;
      }
    }

    updateHitbox() {
      const x = Math.round(this.state.x - RENDERED_SIZE / 2);
      const y = Math.round(this.state.y - RENDERED_SIZE / 2);
      this.hitbox.style.left = x + "px";
      this.hitbox.style.top = y + "px";
    }
  }

  // --- FOCUS / TYPING TRACKER ---
  // Tells greg which text field the user is in and what they're typing, so he
  // can roast it. Only text inputs/textareas — no clicks, scrolls, or buttons.
  function setupFocusTracking(ws, renderer) {
    let debounce = null;

    function isTextField(el) {
      if (!el) return false;
      if (el.isContentEditable) return true;
      if (el instanceof HTMLTextAreaElement) return true;
      if (el instanceof HTMLInputElement) {
        const t = (el.type || "text").toLowerCase();
        return ["text", "search", "url", "email", "", "textarea"].includes(t);
      }
      return false;
    }

    function fieldLabel(el) {
      return (el.getAttribute && (el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("name"))) ||
        (el.id ? "#" + el.id : "") ||
        (el.closest && el.closest("[class]") && el.closest("[class]").className.split(" ")[0]) ||
        "a field";
    }

    function fieldValue(el) {
      const v = el.isContentEditable ? (el.textContent || "") : (el.value || "");
      return v.replace(/\s+/g, " ").trim().slice(0, 160);
    }

    // Buffer the most recent typing payload when WS isn't open yet (cold-start
     // on autofocus inputs like /tasks/new) so the first burst isn't silently
     // dropped. Flushed on ws.onopen below.
    let pendingTyping = null;
    function send(el) {
      // skip greg's own reply box
      if (el.id === "monkey-reply-input") return;
      const payload = {
        type: "user_typing",
        field: String(fieldLabel(el)).slice(0, 40),
        value: fieldValue(el),
      };
      if (ws.readyState !== WebSocket.OPEN) {
        pendingTyping = payload;
        return;
      }
      ws.send(JSON.stringify(payload));
    }
    ws.addEventListener("open", () => {
      if (pendingTyping) {
        try { ws.send(JSON.stringify(pendingTyping)); } catch {}
        pendingTyping = null;
      }
    });

    // Greg does NOT auto-jump on focus. He only becomes AWARE of the field
    // (the element is remembered so the brain can choose to jump to it via a
    // "focus" target, and the typing signal is sent for him to roast).
    function noteField(el) {
      if (!renderer || el.id === "monkey-reply-input") return;
      renderer.currentFocusEl = el;
    }

    document.addEventListener("focusin", (e) => {
      if (!isTextField(e.target)) return;
      noteField(e.target);
    }, true);

    document.addEventListener("input", (e) => {
      const el = e.target;
      if (!isTextField(el)) return;
      noteField(el);
      if (el.id === "monkey-reply-input") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => send(el), 1200);
    }, true);

    // Clear focus signal when leaving a field
    document.addEventListener("focusout", (e) => {
      if (!isTextField(e.target) || e.target.id === "monkey-reply-input") return;
      if (renderer && renderer.currentFocusEl === e.target) renderer.currentFocusEl = null;
      if (debounce) clearTimeout(debounce);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "user_blur" }));
    }, true);
  }

  // --- WEBSOCKET CONNECTION ---
  function connect() {
    // Never run two sockets at once — a stray reconnect + manual re-enable
    // would otherwise stack connections (and, historically, Gregs).
    if (activeWs && (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/monkey`);

    activeWs = ws;

    ws.onopen = () => {
      console.log("[monkey] Connected");
      // Single renderer for the page lifetime. Reusing it across reconnects /
      // re-enables is what prevents infinite Greg spawning.
      if (!activeRenderer) activeRenderer = new MonkeyRenderer();
      const renderer = activeRenderer;
      renderer.setVisible(true);
      renderer.setWs(ws);

      if (!focusTrackingSetup) {
        setupFocusTracking(ws, renderer);
        focusTrackingSetup = true;
      }

      // Send initial DOM scan
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "perches", perches: scanPerches() }));
        ws.send(JSON.stringify({ type: "dom_map", sections: scanDOMMap() }));
      }, 1000);

      // Rescan DOM periodically (HTMX swaps change the page)
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "perches", perches: scanPerches() }));
          ws.send(JSON.stringify({ type: "dom_map", sections: scanDOMMap() }));
        }
      }, 8000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Server reports the active brain persona on init + every command.
        if (msg.persona && activeRenderer) activeRenderer.setCharacter(msg.persona);
        if (msg.type === "command" && activeRenderer) {
          activeRenderer.executeCommand(msg.action);
          activeRenderer.updateState(msg.state);
        }
        if (msg.type === "init" && activeRenderer) {
          activeRenderer.updateState(msg.state);
        }
      } catch {}
    };

    ws.onclose = () => {
      console.log("[monkey] Disconnected");
      if (monkeyEnabled) {
        console.log("[monkey] Reconnecting in 5s...");
        setTimeout(connect, 5000);
      }
    };

    ws.onerror = () => ws.close();
  }

  // --- TOGGLE SUPPORT ---
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  let monkeyEnabled = !isMobile && localStorage.getItem("monkey-enabled") !== "false";
  let activeWs = null;
  let activeRenderer = null;
  let focusTrackingSetup = false;

  function boot() {
    if (monkeyEnabled) {
      connect();
    }
    // Sync toggle state on load
    setTimeout(() => {
      const el = document.getElementById("monkey-toggle");
      if (el) {
        el.dataset.enabled = monkeyEnabled ? "true" : "false";
        el.style.opacity = monkeyEnabled ? "1" : "0.5";
      }
    }, 500);
  }

  window.addEventListener("monkey-toggle", (e) => {
    monkeyEnabled = e.detail.enabled;
    if (!monkeyEnabled) {
      if (activeRenderer) activeRenderer.setVisible(false);
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.close();
      }
    } else {
      if (activeRenderer) activeRenderer.setVisible(true);
      connect();
    }
  });

  // Boot when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
