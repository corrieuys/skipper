/**
 * Zen mode 3D orbs.
 *
 * Replaces the CSS crystal-ball orbs with faceted 3D polygons (icosahedra)
 * wrapped in an orbiting particle shell, rendered with three.js.
 *
 * One shared WebGL canvas is overlaid on the page; each `.zen-orb` element is
 * drawn into its own scissor/viewport region, so the renderer naturally tracks
 * the floating orb rects and works for any team size (one GL context total).
 *
 * Active/inactive state is read from the orb's CSS classes every frame, so the
 * existing 5s `zen-agent-states` poller drives the visuals with no extra wiring.
 *
 * three.js is loaded lazily from a CDN. If it fails to load (no WebGL / offline)
 * nothing is mounted and the original CSS orbs remain visible.
 */
(function () {
  "use strict";
  if (window.__zenOrbs3D) return;
  window.__zenOrbs3D = true;

  var THREE_URL = "https://esm.sh/three@0.160.0";

  // Each orb is drawn into a square region PAD times larger than the orb itself
  // so the orbiting particle shell has room and isn't clipped at the orb box.
  // The camera is pushed back by the same factor so the polygon keeps its size.
  var PAD = 2.4;
  var BASE_Z = 3.4;

  var THREE = null;
  var renderer = null;
  var canvas = null;
  var clock = null;
  var views = []; // { el, scene, camera, mesh, edges, particles, mat, edgeMat, ptMat, baseColor, lit, lerp }
  var booted = false;
  var booting = false;
  var loopRunning = false;

  function hasOrbs() {
    return !!document.querySelector(".zen-orb");
  }

  function cssColor(varName, fallback) {
    var c = new THREE.Color(fallback);
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      if (raw) c.setStyle(raw); // setStyle throws/ignores unknown formats (oklch, color-mix)
    } catch (e) {
      c.set(fallback);
    }
    return c;
  }

  // Atom-style electrons: a few orbital rings tilted onto distinct planes, each
  // carrying a handful of electron points plus a faint orbit trace. Each ring is
  // a group spun on its own axis so the electrons orbit like an atom diagram.
  var RING_DEFS = [
    { r: 1.75, tilt: [0, 0, 0], speed: 1.5, dir: 1, n: 3 },
    { r: 1.95, tilt: [Math.PI / 2.3, 0.6, 0], speed: 1.0, dir: -1, n: 2 },
    { r: 1.6, tilt: [-0.7, 1.35, 0.4], speed: 1.9, dir: 1, n: 2 },
  ];

  function makeElectrons(accent) {
    var group = new THREE.Group();
    var ptMat = new THREE.PointsMaterial({
      color: accent.clone(),
      size: 0.16,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    var orbitMat = new THREE.LineBasicMaterial({
      color: accent.clone(),
      transparent: true,
      opacity: 0.22,
    });
    var rings = [];

    for (var d = 0; d < RING_DEFS.length; d++) {
      var def = RING_DEFS[d];
      var ring = new THREE.Group();
      ring.rotation.set(def.tilt[0], def.tilt[1], def.tilt[2]);

      // faint orbit trace
      var seg = 64;
      var orbit = new Float32Array(seg * 3);
      for (var s = 0; s < seg; s++) {
        var ang = (s / seg) * Math.PI * 2;
        orbit[s * 3] = Math.cos(ang) * def.r;
        orbit[s * 3 + 1] = Math.sin(ang) * def.r;
        orbit[s * 3 + 2] = 0;
      }
      var orbitGeo = new THREE.BufferGeometry();
      orbitGeo.setAttribute("position", new THREE.BufferAttribute(orbit, 3));
      ring.add(new THREE.LineLoop(orbitGeo, orbitMat));

      // electrons spaced evenly around the ring
      var ep = new Float32Array(def.n * 3);
      for (var k = 0; k < def.n; k++) {
        var ea = (k / def.n) * Math.PI * 2;
        ep[k * 3] = Math.cos(ea) * def.r;
        ep[k * 3 + 1] = Math.sin(ea) * def.r;
        ep[k * 3 + 2] = 0;
      }
      var eGeo = new THREE.BufferGeometry();
      eGeo.setAttribute("position", new THREE.BufferAttribute(ep, 3));
      ring.add(new THREE.Points(eGeo, ptMat));

      group.add(ring);
      rings.push({ group: ring, speed: def.speed, dir: def.dir });
    }

    return { group: group, rings: rings, ptMat: ptMat, orbitMat: orbitMat };
  }

  function readAccents() {
    return {
      base: cssColor("--sk-accent-secondary", "#7c93ff"),
      particle: cssColor("--sk-accent-primary", "#b07cff"),
      edge: cssColor("--sk-accent-tertiary", "#7cffd6"),
    };
  }

  // Re-pull theme accents into an existing orb. The per-frame loop derives the
  // mesh color/emissive from baseColor, so updating baseColor is enough there.
  function applyTheme(v) {
    var a = readAccents();
    v.baseColor.copy(a.base);
    v.edgeMat.color.copy(a.edge);
    v.ptMat.color.copy(a.particle);
    v.orbitMat.color.copy(a.particle);
    v.keyLight.color.copy(a.particle);
    v.rimLight.color.copy(a.edge);
  }

  function buildView(el) {
    var acc = readAccents();
    var accent = acc.base;
    var accent2 = acc.particle;
    var accent3 = acc.edge;

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, BASE_Z * PAD);

    // Faceted 3D polygon
    var geo = new THREE.IcosahedronGeometry(1, 0);
    var mat = new THREE.MeshStandardMaterial({
      color: accent.clone(),
      emissive: accent.clone(),
      emissiveIntensity: 0.45,
      metalness: 0.35,
      roughness: 0.35,
      flatShading: true,
      transparent: true,
      opacity: 0.92,
    });
    var mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // Edge wireframe over the facets
    var edgeMat = new THREE.LineBasicMaterial({
      color: accent3.clone(),
      transparent: true,
      opacity: 0.6,
    });
    var edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    mesh.add(edges);

    var electrons = makeElectrons(accent2);
    scene.add(electrons.group);

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    var key = new THREE.PointLight(accent2.clone(), 2.2, 12);
    key.position.set(2.5, 2.5, 3);
    scene.add(key);
    var rim = new THREE.PointLight(accent3.clone(), 1.4, 12);
    rim.position.set(-3, -1.5, 1.5);
    scene.add(rim);

    var view = {
      el: el,
      scene: scene,
      camera: camera,
      mesh: mesh,
      edges: edges,
      mat: mat,
      edgeMat: edgeMat,
      particles: electrons.group,
      rings: electrons.rings,
      ptMat: electrons.ptMat,
      orbitMat: electrons.orbitMat,
      keyLight: key,
      rimLight: rim,
      baseColor: accent.clone(),
      gray: new THREE.Color(0x5a6072),
      lerp: el.classList.contains("zen-orb--active") ? 1 : 0,
      dragging: false,
      velY: 0,
      velX: 0,
    };
    attachDrag(el, view);
    return view;
  }

  // Click-drag to rotate; a quick flick on release spins it with decaying momentum.
  function attachDrag(el, v) {
    var SENS = 0.01; // radians of rotation per pixel dragged
    var lastX = 0;
    var lastY = 0;
    el.style.cursor = "grab";
    el.style.touchAction = "none";

    el.addEventListener("pointerdown", function (e) {
      v.dragging = true;
      v.velY = 0;
      v.velX = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      el.style.cursor = "grabbing";
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    el.addEventListener("pointermove", function (e) {
      if (!v.dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      v.mesh.rotation.y += dx * SENS;
      v.mesh.rotation.x += dy * SENS;
      v.velY = dx * SENS; // last delta carries over as spin momentum
      v.velX = dy * SENS;
      e.preventDefault();
    });

    function end(e) {
      if (!v.dragging) return;
      v.dragging = false;
      el.style.cursor = "grab";
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function disposeView(v) {
    v.mesh.geometry.dispose();
    v.mat.dispose();
    v.edges.geometry.dispose();
    v.edgeMat.dispose();
    v.particles.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
    });
    v.ptMat.dispose();
    v.orbitMat.dispose();
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
    // We clear once per frame and only clear depth per orb, so padded orb regions
    // can overlap and blend additively instead of wiping each other.
    renderer.autoClear = false;
    clock = new THREE.Clock();
  }

  function loop() {
    if (!loopRunning) return;
    requestAnimationFrame(loop);

    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setSize(w, h, false);

    var dt = Math.min(clock.getDelta(), 0.05);

    // One full clear, then each orb only clears its own depth (see initRenderer).
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
        continue; // offscreen, skip draw
      }

      // ease toward active/inactive target
      var target = v.el.classList.contains("zen-orb--active") ? 1 : 0;
      v.lerp += (target - v.lerp) * Math.min(dt * 4, 1);
      var a = v.lerp;

      // Rotation: drag drives it directly; otherwise momentum + a gentle idle spin.
      if (!v.dragging) {
        var idle = (0.25 + 0.85 * a) * dt;
        v.mesh.rotation.y += v.velY + idle;
        v.mesh.rotation.x += v.velX;
        v.velY *= 0.94;
        v.velX *= 0.94;
        if (Math.abs(v.velY) < 1e-4) v.velY = 0;
        if (Math.abs(v.velX) < 1e-4) v.velX = 0;
      }
      // Keep the vertical tumble sane so it never locks upside down.
      var maxX = Math.PI / 2;
      if (v.mesh.rotation.x > maxX) v.mesh.rotation.x = maxX;
      if (v.mesh.rotation.x < -maxX) v.mesh.rotation.x = -maxX;

      // Gentle overall tumble, plus each ring orbiting on its own plane.
      v.particles.rotation.y -= dt * (0.05 + 0.12 * a);
      v.particles.rotation.x += dt * 0.03;
      for (var r = 0; r < v.rings.length; r++) {
        var ring = v.rings[r];
        ring.group.rotation.z += dt * ring.speed * ring.dir * (0.4 + 0.9 * a);
      }

      var pulse = 1 + 0.06 * a * Math.sin(clock.elapsedTime * 2.5);
      v.mesh.scale.setScalar(pulse);

      v.mat.color.copy(v.gray).lerp(v.baseColor, 0.25 + 0.75 * a);
      v.mat.emissive.copy(v.baseColor);
      v.mat.emissiveIntensity = 0.12 + 0.7 * a;
      v.edgeMat.opacity = 0.2 + 0.55 * a;
      v.ptMat.opacity = 0.35 + 0.55 * a;
      v.ptMat.size = 0.1 + 0.06 * a;
      v.orbitMat.opacity = 0.07 + 0.2 * a;

      // Padded square region centered on the orb so particles aren't clipped.
      var size = Math.max(rect.width, rect.height) * PAD;
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var left = cx - size / 2;
      var bottom = h - (cy + size / 2);
      renderer.setViewport(left, bottom, size, size);
      renderer.setScissor(left, bottom, size, size);
      renderer.clearDepth(); // depth-only, confined to this orb's scissor box
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
