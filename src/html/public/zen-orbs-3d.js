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
    };
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
    canvas.style.cssText =
      "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:5;";
    document.body.appendChild(canvas);
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

  function loop() {
    if (!loopRunning) return;
    requestAnimationFrame(loop);

    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setSize(w, h, false);

    var dt = Math.min(clock.getDelta(), 0.05);
    var t = clock.elapsedTime;

    renderer.setScissorTest(false);
    renderer.clear(true, true, false);
    renderer.setScissorTest(true);

    for (var i = views.length - 1; i >= 0; i--) {
      var v = views[i];
      if (!document.contains(v.el)) {
        disposeView(v);
        views.splice(i, 1);
        continue;
      }

      var rect = v.el.getBoundingClientRect();
      if (rect.width < 1 || rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) {
        continue; // offscreen
      }

      // Ease toward active/inactive target, persisting the value by seed so the
      // next rebuilt view resumes it (see lerpState) instead of cutting.
      var target = v.el.classList.contains("zen-orb--active") ? 1 : 0;
      v.lerp += (target - v.lerp) * Math.min(dt * 4, 1);
      // Snap once inside a deadzone: the ease is asymptotic, so without this
      // `a` lingers as a tiny sliver and slerping it against the always-advancing
      // tumble pose gives a settled cube perpetual sub-pixel jitter.
      if (Math.abs(v.lerp - target) < 0.002) v.lerp = target;
      lerpState[v.seed] = v.lerp;
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

      // Padded square region centred on the orb.
      var size = Math.max(rect.width, rect.height) * PAD;
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var left = cx - size / 2;
      var bottom = h - (cy + size / 2);
      renderer.setViewport(left, bottom, size, size);
      renderer.setScissor(left, bottom, size, size);
      renderer.clearDepth();
      renderer.render(v.scene, v.camera);
    }
  }

  function ensureLoop() {
    if (loopRunning) return;
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

  // Orbs are injected via HTMX after page load and re-polled, so watch the DOM.
  var observer = new MutationObserver(function () {
    start();
  });

  // Theme picker swaps <html data-theme> live (no reload), so recolor on change.
  var themeObserver = new MutationObserver(function () {
    for (var i = 0; i < views.length; i++) applyTheme(views[i]);
  });

  function init() {
    observer.observe(document.body, { childList: true, subtree: true });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
