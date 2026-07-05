/**
 * Zen mode 3D orbs.
 *
 * Renders each `.zen-orb` element as a simple faceted cube on a single shared
 * WebGL canvas overlaid on the page. Each orb is drawn into its own
 * scissor/viewport region that tracks the element's rect, so it works for any
 * team size with one GL context total.
 *
 * Orientation is a deterministic function of the shared clock plus a per-agent
 * seed (hashed from the orb's data-zen-agent), so nothing needs persisting and a
 * DOM re-render never jumps — a rebuilt cube recomputes the exact same pose:
 *   - inactive → the cube faces the camera as a flat, static square
 *   - active   → the cube tumbles on all axes with random accel/decel, and bobs
 *
 * three.js is loaded lazily from a CDN. If it fails (no WebGL / offline) nothing
 * is mounted and the original CSS orbs remain visible.
 */
(function () {
  "use strict";
  if (window.__zenOrbs3D) return;
  window.__zenOrbs3D = true;

  var THREE_URL = "https://esm.sh/three@0.160.0";

  // Each orb is drawn into a square region PAD times larger than the orb, with
  // the camera pushed back by the same factor so the cube keeps its size while
  // leaving room for the tumbling corners and the up/down bob.
  var PAD = 1.5;
  var BASE_Z = 3.4;
  var CUBE = 1.2;        // cube edge length (world units)
  var SPEED = 4;         // peak angular-speed multiplier (ramp timing unchanged)

  var THREE = null;
  var renderer = null;
  var canvas = null;
  var clock = null;
  var views = [];
  var booted = false;
  var booting = false;
  var loopRunning = false;

  // Set when an orb was added/removed from the DOM; the loop rescans on its next
  // frame (not a timer) so a state-change DOM swap rebuilds cubes the same frame
  // the old ones are disposed, leaving no visible gap.
  var needScan = false;

  // getBoundingClientRect forces layout, and the activity feed dirties layout
  // constantly, so reading a rect every frame per cube reflows the whole page on
  // the hot path. Instead we cache each cube's rect and only re-measure when the
  // page could actually have moved them: scroll, resize, or a DOM mutation.
  var rectsDirty = true;

  // The canvas is sized/positioned to the bounding box of the currently-visible
  // cubes, not the full screen. A full-screen transparent WebGL layer forces the
  // browser to composite the entire viewport every frame; a tight region is a
  // fraction of that. Recomputed only when rects are re-measured.
  var regLeft = 0, regTop = 0, regW = 0, regH = 0;
  var regionShown = false;

  // Reused scratch objects (set once THREE has loaded) to avoid per-frame allocs.
  var scratchEuler = null;
  var scratchQuat = null;
  var identQuat = null;

  // Active↔inactive transition value (0..1) per agent seed. The steer panel
  // re-renders replace the .zen-orb DOM nodes on every poll, so a rebuilt view
  // must resume its in-flight transition here instead of snapping back to 0
  // (which would cut a deactivating cube straight to flat and restart the
  // fade-in of active ones). Orientation itself is deterministic and needs no
  // persisting; only this eased value does.
  var lerpState = Object.create(null);

  function hasOrbs() {
    return !!document.querySelector(".zen-orb");
  }

  // Stable hash of a string → uint32, so each agent seeds the same tumble.
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  // Deterministic PRNG seeded from the hash, for per-agent tumble parameters.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Per-axis tumble: a base spin plus two sines, giving smoothly ramping angular
  // velocity (accelerate/decelerate, occasionally reversing) that reads as random.
  function makeAxis(rng) {
    return {
      base: (0.15 + rng() * 0.35) * (rng() < 0.5 ? -1 : 1),
      a1: 0.35 + rng() * 0.5, f1: 0.3 + rng() * 0.5, p1: rng() * 6.2832,
      a2: 0.2 + rng() * 0.35, f2: 0.7 + rng() * 0.7, p2: rng() * 6.2832,
    };
  }
  function axisAngle(ax, t) {
    // Scaling the whole angle by SPEED raises peak velocity without touching the
    // sine frequencies, so the accel/decel ramp times stay the same.
    return SPEED * (ax.base * t + ax.a1 * Math.sin(t * ax.f1 + ax.p1) + ax.a2 * Math.sin(t * ax.f2 + ax.p2));
  }

  function cssColor(varName, fallback) {
    var c = new THREE.Color(fallback);
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      if (raw) c.setStyle(raw); // setStyle ignores unknown formats (oklch, color-mix)
    } catch (e) {
      c.set(fallback);
    }
    return c;
  }

  function readAccents() {
    return {
      base: cssColor("--sk-accent-secondary", "#7c93ff"),
      light: cssColor("--sk-accent-primary", "#b07cff"),
      // Edges are brightened toward white for strong contrast against the faces.
      edge: cssColor("--sk-accent-tertiary", "#7cffd6").lerp(new THREE.Color(0xffffff), 0.35),
    };
  }

  // Re-pull theme accents into an existing orb (theme picker swaps live).
  function applyTheme(v) {
    var a = readAccents();
    v.baseColor.copy(a.base);
    v.edgeMat.color.copy(a.edge);
    v.keyLight.color.copy(a.light);
    v.rimLight.color.copy(a.edge);
  }

  function buildView(el) {
    var acc = readAccents();

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, BASE_Z * PAD);

    var geo = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
    var mat = new THREE.MeshStandardMaterial({
      color: acc.base.clone(),
      emissive: acc.base.clone(),
      emissiveIntensity: 0.3,
      metalness: 0.35,
      roughness: 0.5,
      flatShading: true,
      transparent: true,
      opacity: 0.95,
    });
    var mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    var edgeMat = new THREE.LineBasicMaterial({
      color: acc.edge.clone(),
      transparent: true,
      opacity: 1,
    });
    var edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    mesh.add(edges);

    // Dimmer ambient so the (darker) faces contrast harder with the bright edges.
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));
    var keyLight = new THREE.PointLight(acc.light.clone(), 2.0, 12);
    keyLight.position.set(2.5, 2.5, 3);
    scene.add(keyLight);
    var rim = new THREE.PointLight(acc.edge.clone(), 1.2, 12);
    rim.position.set(-3, -1.5, 1.5);
    scene.add(rim);

    // Clickable dashboard orbs steer on click (via document delegation); just
    // give them the pointer cursor. Nothing is draggable.
    if (el.dataset.zenNoDrag === "1" && el.hasAttribute("data-mc-agent-tile")) {
      el.style.cursor = "pointer";
    }

    // Per-agent tumble seed (stable across re-renders → deterministic pose).
    var seedStr = el.getAttribute("data-zen-agent") || el.getAttribute("data-agent-name") || el.id || "orb";
    var rng = mulberry32(hashStr(seedStr));

    return {
      el: el,
      seed: seedStr,
      scene: scene,
      camera: camera,
      mesh: mesh,
      edges: edges,
      mat: mat,
      edgeMat: edgeMat,
      keyLight: keyLight,
      rimLight: rim,
      baseColor: acc.base.clone(),
      gray: new THREE.Color(0x4a4f60),
      spin: { x: makeAxis(rng), y: makeAxis(rng), z: makeAxis(rng) },
      // Resume the in-flight transition value across DOM re-renders so a rebuilt
      // cube eases smoothly instead of snapping. First-ever view starts flat (0).
      lerp: seedStr in lerpState ? lerpState[seedStr] : 0,
      // Nearest horizontally-scrollable ancestor. When an orb lives inside a
      // scroll container (e.g. the task-bar phase/cube strip), its cube must be
      // clipped to that container's left/right edges — the WebGL overlay is a
      // fixed full-viewport layer that otherwise paints scrolled-out cubes over
      // neighbouring elements (the title, the action buttons).
      clipEl: findClipAncestor(el),
      clipRect: null,
    };
  }

  // Walk up for the nearest ancestor that clips its overflow on the x-axis.
  // null → orb isn't inside a scroll region, so no clipping is applied.
  function findClipAncestor(el) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var ov = getComputedStyle(node).overflowX;
      if (ov === "auto" || ov === "scroll" || ov === "hidden") return node;
      node = node.parentElement;
    }
    return null;
  }

  function disposeView(v) {
    v.mesh.geometry.dispose();
    v.mat.dispose();
    v.edges.geometry.dispose();
    v.edgeMat.dispose();
  }

  function scan() {
    var els = document.querySelectorAll(".zen-orb");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.dataset.zen3d === "1") continue;
      el.dataset.zen3d = "1";
      views.push(buildView(el));
    }
    if (views.length > 0) document.body.classList.add("zen-3d-on");
  }

  function initRenderer() {
    canvas = document.createElement("canvas");
    canvas.id = "zen-orbs-3d-canvas";
    // Starts collapsed; the loop sizes/positions it to the visible cubes' bbox.
    canvas.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:5;";
    document.body.appendChild(canvas);
    // Antialias on + retina DPR for crisp cube edges. Affordable because the
    // canvas is sized to the small bbox of the visible cubes (see remeasure),
    // not the full screen.
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    // Clear once per frame; only clear depth per orb so padded regions can overlap.
    renderer.autoClear = false;
    clock = new THREE.Clock();
    scratchEuler = new THREE.Euler();
    scratchQuat = new THREE.Quaternion();
    identQuat = new THREE.Quaternion();
  }

  // Re-measure every cube's rect and fit the canvas to the union of the visible
  // ones' padded draw regions. Called only when rectsDirty (scroll/resize/DOM).
  function remeasure() {
    var w = window.innerWidth, h = window.innerHeight;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      if (!document.contains(v.el)) { v.rect = null; v.clipRect = null; continue; }
      var r = v.el.getBoundingClientRect();
      v.rect = r;
      v.clipRect = v.clipEl && document.contains(v.clipEl) ? v.clipEl.getBoundingClientRect() : null;
      if (r.width < 1 || r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue;
      var size = Math.max(r.width, r.height) * PAD;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx - size / 2 < minX) minX = cx - size / 2;
      if (cy - size / 2 < minY) minY = cy - size / 2;
      if (cx + size / 2 > maxX) maxX = cx + size / 2;
      if (cy + size / 2 > maxY) maxY = cy + size / 2;
      any = true;
    }
    regionShown = any;
    if (any) {
      regLeft = Math.floor(minX); regTop = Math.floor(minY);
      regW = Math.ceil(maxX) - regLeft; regH = Math.ceil(maxY) - regTop;
      canvas.style.left = regLeft + "px";
      canvas.style.top = regTop + "px";
      canvas.style.width = regW + "px";
      canvas.style.height = regH + "px";
      renderer.setSize(regW, regH, false);
    } else {
      canvas.style.width = "0px";
      canvas.style.height = "0px";
    }
    rectsDirty = false;
  }

  function loop() {
    if (!loopRunning) return;

    var w = window.innerWidth;
    var h = window.innerHeight;

    var dt = Math.min(clock.getDelta(), 0.05);
    var t = clock.elapsedTime;

    // Rebuild views for any newly-inserted orbs before drawing this frame, so a
    // DOM swap never leaves a frame with the old cube gone and the new one absent.
    if (needScan) { scan(); needScan = false; }

    // Re-measure rects + refit the canvas region only when something could have
    // moved the cubes. The spinning hot path never touches layout.
    if (rectsDirty) remeasure();

    if (regionShown) {
      renderer.setScissorTest(false);
      renderer.clear(true, true, false);
      renderer.setScissorTest(true);
    }

    // Track whether anything still needs animating.
    var busy = false;

    for (var i = views.length - 1; i >= 0; i--) {
      var v = views[i];
      if (!document.contains(v.el)) {
        disposeView(v);
        views.splice(i, 1);
        continue;
      }

      // Ease toward active/inactive target for every view (cheap), persisting the
      // value by seed so the next rebuilt view resumes it (see lerpState) instead
      // of cutting. Done before the offscreen check so an orb that deactivates
      // while scrolled out of view still settles and lets the loop idle.
      var target = v.el.classList.contains("zen-orb--active") ? 1 : 0;
      v.lerp += (target - v.lerp) * Math.min(dt * 4, 1);
      // Snap once inside a deadzone: the ease is asymptotic, so without this
      // `a` lingers as a tiny sliver and slerping it against the always-advancing
      // tumble pose gives a settled cube perpetual sub-pixel jitter.
      if (Math.abs(v.lerp - target) < 0.002) v.lerp = target;
      lerpState[v.seed] = v.lerp;
      if (target === 1 || v.lerp > 0.0001) busy = true;

      // Cached rect (measured in remeasure()); null or offscreen → no draw.
      var rect = v.rect;
      if (!rect || rect.width < 1 || rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) {
        continue; // lerp already advanced above, skip only the draw
      }

      var a = v.lerp;

      // Tumble pose is a pure function of the shared clock + per-agent seed, so a
      // re-render never jumps. Slerp from the identity (flat square facing the
      // camera, inactive) toward the tumbling pose by `a`, which keeps the
      // active↔inactive transition smooth despite large tumble angles.
      scratchEuler.set(axisAngle(v.spin.x, t), axisAngle(v.spin.y, t), axisAngle(v.spin.z, t));
      scratchQuat.setFromEuler(scratchEuler);
      v.mesh.quaternion.slerpQuaternions(identQuat, scratchQuat, a);

      // Colour/emissive fade in/out with the active transition; edges stay bright
      // + opaque for contrast. The cube stays put (no bob).
      v.mat.color.copy(v.gray).lerp(v.baseColor, 0.25 + 0.75 * a);
      v.mat.emissive.copy(v.baseColor);
      v.mat.emissiveIntensity = 0.06 + 0.32 * a;
      v.edgeMat.opacity = 0.85 + 0.15 * a;

      // Padded square region centred on the orb, expressed in canvas-local
      // coordinates (the canvas is offset to regLeft/regTop, GL y-axis is up).
      var size = Math.max(rect.width, rect.height) * PAD;
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var left = (cx - size / 2) - regLeft;
      var bottom = regH - ((cy - regTop) + size / 2);

      // Viewport places the cube geometry; scissor decides which pixels survive.
      // Clip the scissor's x-span to the orb's scroll container so a cube that
      // has scrolled under a neighbouring element isn't painted over it. Only
      // the x-axis is clipped (vertical padding room for the tumble/bob stays),
      // and the viewport is left at the full square so the cube isn't squashed.
      var scLeftVp = cx - size / 2;
      var scRightVp = cx + size / 2;
      if (v.clipRect) {
        if (v.clipRect.left > scLeftVp) scLeftVp = v.clipRect.left;
        if (v.clipRect.right < scRightVp) scRightVp = v.clipRect.right;
      }
      if (scRightVp - scLeftVp < 1) continue; // fully clipped out of the container
      var scLeft = scLeftVp - regLeft;
      var scWidth = scRightVp - scLeftVp;

      renderer.setViewport(left, bottom, size, size);
      renderer.setScissor(scLeft, bottom, scWidth, size);
      renderer.clearDepth();
      renderer.render(v.scene, v.camera);
    }

    // Keep going only while something is animating; otherwise idle until woken.
    if (busy) requestAnimationFrame(loop);
    else loopRunning = false;
  }

  function ensureLoop() {
    if (!booted || loopRunning) return;
    loopRunning = true;
    requestAnimationFrame(loop);
  }

  function start() {
    if (booted) {
      scan();
      ensureLoop();
      return;
    }
    if (booting || !hasOrbs()) return;
    booting = true;
    import(THREE_URL)
      .then(function (mod) {
        THREE = mod;
        booted = true;
        booting = false;
        initRenderer();
        scan();
        ensureLoop();
      })
      .catch(function (e) {
        booting = false;
        console.warn("zen-orbs-3d: three.js failed to load, keeping CSS orbs", e);
      });
  }

  // True if a mutation record added or removed an actual orb node. The activity
  // feed and terminal output fire dozens of mutations/sec that never touch orbs;
  // ignoring those keeps the render loop asleep during output bursts.
  function nodesHaveOrb(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains("zen-orb")) return true;
      if (n.querySelector && n.querySelector(".zen-orb")) return true;
    }
    return false;
  }
  function touchesOrbs(records) {
    for (var i = 0; i < records.length; i++) {
      if (nodesHaveOrb(records[i].addedNodes) || nodesHaveOrb(records[i].removedNodes)) return true;
    }
    return false;
  }

  // Orbs are injected via HTMX after page load and re-swapped on state changes.
  // Only orb-touching mutations matter: flag a rescan + re-measure and wake the
  // loop, which rebuilds the new cubes on its next frame (no visible gap).
  var observer = new MutationObserver(function (records) {
    if (!touchesOrbs(records)) return;
    rectsDirty = true;
    if (booted) {
      needScan = true;
      ensureLoop();
    } else {
      start();
    }
  });

  // Theme picker swaps <html data-theme> live (no reload), so recolor on change.
  var themeObserver = new MutationObserver(function () {
    for (var i = 0; i < views.length; i++) applyTheme(views[i]);
    ensureLoop(); // repaint once with the new accents even if idle
  });

  // The orb canvas is fixed full-screen; when the loop is idle and the page
  // scrolls or resizes, the painted cubes would drift off their DOM slots. Flag
  // the rects stale and wake the loop so it repaints them in place (then idles).
  function wake() {
    rectsDirty = true;
    ensureLoop();
  }
  function init() {
    observer.observe(document.body, { childList: true, subtree: true });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    // remeasure() (triggered by rectsDirty) refits the canvas + draw buffer, so
    // scroll and resize share the same wake path.
    window.addEventListener("scroll", wake, { passive: true, capture: true });
    window.addEventListener("resize", wake);
    start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
