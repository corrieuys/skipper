/**
 * Agent cube — 2D.
 *
 * Each `.zen-orb` element is a flat rounded square (styled in CSS) that spins
 * in-plane while its agent is active. This replaces the old WebGL/three.js 3D
 * tumbling cube with the flat echo used by the Skipper iOS app: no canvas, no
 * three.js CDN, no per-frame layout reads — one shared rAF loop that only writes
 * a `transform: rotate()` on the active orbs (a composited property, cheap).
 *
 * The spin is a deterministic function of a shared clock + a per-agent seed
 * (hashed from data-zen-agent), so a DOM re-render never jumps: a rebuilt orb
 * recomputes the exact same pose. Idle orbs sit still (dimmed by CSS). The angle
 * is `speed·(base·t + a1·sin(f1·t+p1) + a2·sin(f2·t+p2))` — a steady drift plus
 * two out-of-phase sines, so the spin speeds up, slows, and occasionally
 * reverses. Same hash/PRNG/parameter ranges as the iOS SpinningCube.
 *
 * prefers-reduced-motion → no rotation (the square stays put, still colour-coded
 * active/idle by CSS).
 */
(function () {
  "use strict";
  if (window.__zenCube2D) return;
  window.__zenCube2D = true;

  // Peak angular-speed multiplier. Matches the iOS cube (well above the old 3D
  // cube's 4) so the flat square reads as energetic.
  var SPEED = 8;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* no matchMedia → animate */ }

  var loopRunning = false;

  // Stable hash of a string → uint32 (FNV-1a), so each agent seeds the same spin.
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  // Deterministic PRNG seeded from the hash (mulberry32).
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // One in-plane axis: a base spin plus two sines → smoothly ramping angular
  // velocity (accelerate/decelerate, occasionally reversing). Same ranges as the
  // iOS Spin: a stronger base than the 3D cube's per-axis drift.
  function makeSpin(seedStr) {
    var rng = mulberry32(hashStr(seedStr));
    return {
      base: (0.6 + rng() * 0.6) * (rng() < 0.5 ? -1 : 1),
      a1: 0.35 + rng() * 0.5, f1: 0.3 + rng() * 0.5, p1: rng() * 6.2832,
      a2: 0.2 + rng() * 0.35, f2: 0.7 + rng() * 0.7, p2: rng() * 6.2832,
    };
  }
  function spinAngle(s, t) {
    return SPEED * (s.base * t + s.a1 * Math.sin(t * s.f1 + s.p1) + s.a2 * Math.sin(t * s.f2 + s.p2));
  }

  // Cache the parsed spin params per element (keyed on the seed the element
  // carries) so a re-render with the same agent keeps the same motion.
  function spinFor(el) {
    var seed = el.getAttribute("data-zen-agent") || el.getAttribute("data-agent-name") || el.id || "orb";
    if (el.__zenSeed !== seed) { el.__zenSeed = seed; el.__zenSpin = makeSpin(seed); }
    return el.__zenSpin;
  }

  // The `.zen-orb` is a reserved box; the visible square is an inner
  // `.zen-orb__cube` sized smaller than the box so its corners never leave the
  // box as it rotates (mirrors the iOS SpinningCube's 1.5x reserve). We rotate
  // the inner cube, NOT the orb, so nothing ever paints outside the orb's own
  // bounds — a scroll/overflow ancestor can't clip the spinning corners. Create
  // the cube lazily so any `.zen-orb` producer works without markup changes.
  function cubeFor(el) {
    var cube = el.__zenCube;
    if (cube && cube.parentNode === el) return cube;
    cube = el.querySelector(".zen-orb__cube");
    if (!cube) {
      cube = document.createElement("span");
      cube.className = "zen-orb__cube";
      el.appendChild(cube);
    }
    el.__zenCube = cube;
    return cube;
  }

  function frame() {
    if (!loopRunning) return;
    var t = performance.now() / 1000;
    var orbs = document.querySelectorAll(".zen-orb");
    var anyActive = false;
    for (var i = 0; i < orbs.length; i++) {
      var el = orbs[i];
      var cube = cubeFor(el);
      var active = el.classList.contains("zen-orb--active");
      if (active && !reduceMotion) {
        cube.style.transform = "rotate(" + spinAngle(spinFor(el), t) + "rad)";
        anyActive = true;
      } else if (cube.style.transform) {
        // Settle a cube that just went idle (or reduced-motion) back to square.
        cube.style.transform = "";
      }
    }
    // Keep spinning only while something is active; otherwise idle until woken.
    if (anyActive && !reduceMotion) requestAnimationFrame(frame);
    else loopRunning = false;
  }

  function wake() {
    if (loopRunning) return;
    loopRunning = true;
    requestAnimationFrame(frame);
  }

  // Orbs are injected via HTMX after load and re-swapped on state changes; a
  // class flip (active↔inactive) or a node swap should wake the loop so the new
  // state animates (or settles) on the next frame.
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "attributes") {
        if (r.target.classList && r.target.classList.contains("zen-orb")) { wake(); return; }
        continue;
      }
      if (touches(r.addedNodes) || touches(r.removedNodes)) { wake(); return; }
    }
  });
  function touches(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains("zen-orb")) return true;
      if (n.querySelector && n.querySelector(".zen-orb")) return true;
    }
    return false;
  }

  function init() {
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class"],
    });
    wake();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
