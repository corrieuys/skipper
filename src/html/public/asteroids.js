(function () {
  var canvas = document.getElementById('game-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var root = document.getElementById('asteroids-root');
  if (!root) return;

  // ── Resize ─────────────────────────────────────────────────────────────
  function resize() {
    canvas.width = root.offsetWidth;
    canvas.height = root.offsetHeight;
  }
  window.addEventListener('resize', function () { resize(); });

  // ── Theme colors ────────────────────────────────────────────────────────
  var colors = {};
  var colorFrame = 0;

  function readColors() {
    var s = getComputedStyle(document.documentElement);
    function v(prop, fallback) {
      var val = s.getPropertyValue(prop).trim();
      return val || fallback;
    }
    colors = {
      ship:     v('--sk-accent-primary',   '#ff89ab'),
      thrust:   v('--accent-yellow',       '#ffd080'),
      bullet:   v('--sk-accent-secondary', '#00fbfb'),
      asteroid: v('--sk-text-muted',       '#adaaaa'),
      hud:      v('--sk-text',             '#ffffff'),
      gameOver: v('--sk-accent-primary',   '#ff6b6b'),
      start:    v('--sk-accent-tertiary',  '#b0ff96'),
      explosion:v('--sk-accent-primary',   '#ff89ab'),
      font:     v('--sk-font-mono',        'monospace'),
    };
  }

  // ── State ───────────────────────────────────────────────────────────────
  var STATE = { START: 'START', PLAYING: 'PLAYING', PAUSED: 'PAUSED', GAME_OVER: 'GAME_OVER' };
  var state = STATE.START;
  var score = 0;
  var lives = 3;
  var wave = 1;
  var waveTimer = 0;
  var waveDelay = 0;
  var lastTime = 0;

  // ── Input ────────────────────────────────────────────────────────────────
  var keys = {};
  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    var block = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
    if (block.indexOf(e.code) !== -1) e.preventDefault();
    if (e.code === 'Enter') {
      if (state === STATE.START || state === STATE.GAME_OVER) startGame();
    }
    if (e.code === 'Escape') {
      if (state === STATE.PLAYING) state = STATE.PAUSED;
      else if (state === STATE.PAUSED) state = STATE.PLAYING;
    }
  });
  document.addEventListener('keyup', function (e) { keys[e.code] = false; });

  // ── Ship ─────────────────────────────────────────────────────────────────
  var ship = null;

  function createShip() {
    return {
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: 0, vy: 0,
      angle: -Math.PI / 2,
      radius: 12,
      invincible: 0,
    };
  }

  // ── Asteroid helpers ──────────────────────────────────────────────────────
  var SIZES = { large: 40, medium: 20, small: 10 };
  var SCORES = { large: 20, medium: 50, small: 100 };

  function createAsteroid(x, y, size, speedMult) {
    var radius = SIZES[size];
    var angle = Math.random() * Math.PI * 2;
    var speed = (0.8 + Math.random() * 1.2) * speedMult;
    var numVerts = 8 + Math.floor(Math.random() * 5);
    var verts = [];
    for (var i = 0; i < numVerts; i++) {
      var a = (i / numVerts) * Math.PI * 2;
      var r = radius * (0.7 + Math.random() * 0.6);
      verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return {
      x: x, y: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: radius,
      size: size,
      rotation: 0,
      rotSpeed: (Math.random() - 0.5) * 0.04,
      verts: verts,
    };
  }

  function edgeSpawn() {
    var side = Math.floor(Math.random() * 4);
    var x, y;
    if (side === 0)      { x = Math.random() * canvas.width; y = -10; }
    else if (side === 1) { x = canvas.width + 10; y = Math.random() * canvas.height; }
    else if (side === 2) { x = Math.random() * canvas.width; y = canvas.height + 10; }
    else                 { x = -10; y = Math.random() * canvas.height; }
    // Push away from center if too close
    var cx = canvas.width / 2, cy = canvas.height / 2;
    var dx = x - cx, dy = y - cy;
    if (Math.sqrt(dx * dx + dy * dy) < 100) {
      x = (Math.random() < 0.5) ? -10 : canvas.width + 10;
    }
    return { x: x, y: y };
  }

  function spawnWave() {
    var count = Math.min(4 + (wave - 1), 12);
    var speedMult = 1 + (wave - 1) * 0.08;
    asteroids = [];
    for (var i = 0; i < count; i++) {
      var pos = edgeSpawn();
      asteroids.push(createAsteroid(pos.x, pos.y, 'large', speedMult));
    }
  }

  // ── Collections ──────────────────────────────────────────────────────────
  var asteroids = [];
  var bullets = [];
  var particles = [];
  var bgAsteroids = [];
  var fireCooldown = 0;

  function spawnBgAsteroids() {
    bgAsteroids = [];
    var sizes = ['large', 'medium', 'small'];
    for (var i = 0; i < 7; i++) {
      var x = Math.random() * canvas.width;
      var y = Math.random() * canvas.height;
      var sz = sizes[Math.floor(Math.random() * sizes.length)];
      bgAsteroids.push(createAsteroid(x, y, sz, 0.4));
    }
  }

  // ── Game start ───────────────────────────────────────────────────────────
  function startGame() {
    score = 0;
    lives = 3;
    wave = 1;
    asteroids = [];
    bullets = [];
    particles = [];
    fireCooldown = 0;
    waveTimer = 90;
    waveDelay = 90;
    ship = createShip();
    state = STATE.PLAYING;
  }

  // ── Wrap ─────────────────────────────────────────────────────────────────
  function wrap(obj) {
    var w = canvas.width, h = canvas.height;
    if (obj.x < -obj.radius) obj.x = w + obj.radius;
    if (obj.x > w + obj.radius) obj.x = -obj.radius;
    if (obj.y < -obj.radius) obj.y = h + obj.radius;
    if (obj.y > h + obj.radius) obj.y = -obj.radius;
  }

  function dist2(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function explode(x, y, count, speed) {
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var s = speed * (0.5 + Math.random());
      particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 30, maxLife: 30 });
    }
  }

  // ── Update ───────────────────────────────────────────────────────────────
  function update(delta) {
    colorFrame++;
    if (colorFrame >= 60) { readColors(); colorFrame = 0; }

    if (state === STATE.PLAYING) {
      updatePlaying(delta);
    } else {
      // Drift bg asteroids on start/game-over screens
      for (var i = 0; i < bgAsteroids.length; i++) {
        var a = bgAsteroids[i];
        a.x += a.vx * delta;
        a.y += a.vy * delta;
        a.rotation += a.rotSpeed * delta;
        wrap(a);
      }
    }
  }

  function updatePlaying(delta) {
    if (!ship) return;

    // Rotate
    if (keys['ArrowLeft'])  ship.angle -= 0.0873 * delta;
    if (keys['ArrowRight']) ship.angle += 0.0873 * delta;

    // Thrust
    if (keys['ArrowUp']) {
      ship.vx += Math.cos(ship.angle) * 0.3 * delta;
      ship.vy += Math.sin(ship.angle) * 0.3 * delta;
      var spd = Math.sqrt(ship.vx * ship.vx + ship.vy * ship.vy);
      if (spd > 8) { ship.vx = ship.vx / spd * 8; ship.vy = ship.vy / spd * 8; }
    }

    // Friction
    var friction = Math.pow(0.99, delta);
    ship.vx *= friction;
    ship.vy *= friction;

    ship.x += ship.vx * delta;
    ship.y += ship.vy * delta;
    wrap(ship);

    if (ship.invincible > 0) ship.invincible -= delta;

    // Fire
    if (fireCooldown > 0) fireCooldown -= delta;
    if (keys['Space'] && fireCooldown <= 0 && bullets.length < 5) {
      fireCooldown = 10;
      bullets.push({
        x: ship.x + Math.cos(ship.angle) * ship.radius,
        y: ship.y + Math.sin(ship.angle) * ship.radius,
        vx: Math.cos(ship.angle) * 10 + ship.vx * 0.5,
        vy: Math.sin(ship.angle) * 10 + ship.vy * 0.5,
        radius: 2,
        life: 60,
      });
    }

    // Update bullets
    var aliveBullets = [];
    for (var bi = 0; bi < bullets.length; bi++) {
      var b = bullets[bi];
      b.x += b.vx * delta;
      b.y += b.vy * delta;
      b.life -= delta;
      wrap(b);
      if (b.life > 0) aliveBullets.push(b);
    }
    bullets = aliveBullets;

    // Update asteroids
    for (var ai = 0; ai < asteroids.length; ai++) {
      var ast = asteroids[ai];
      ast.x += ast.vx * delta;
      ast.y += ast.vy * delta;
      ast.rotation += ast.rotSpeed * delta;
      wrap(ast);
    }

    // Update particles
    var aliveParticles = [];
    for (var pi = 0; pi < particles.length; pi++) {
      var p = particles[pi];
      p.x += p.vx * delta;
      p.y += p.vy * delta;
      p.life -= delta;
      if (p.life > 0) aliveParticles.push(p);
    }
    particles = aliveParticles;

    // Bullet-asteroid collisions
    var newAsteroids = [];
    var hitBullets = new Array(bullets.length).fill(false);
    var hitAsteroids = new Array(asteroids.length).fill(false);
    var speedMult = 1 + (wave - 1) * 0.08;

    for (var bi2 = 0; bi2 < bullets.length; bi2++) {
      if (hitBullets[bi2]) continue;
      for (var ai2 = 0; ai2 < asteroids.length; ai2++) {
        if (hitAsteroids[ai2]) continue;
        var b2 = bullets[bi2], ast2 = asteroids[ai2];
        if (dist2(b2, ast2) < ast2.radius) {
          hitBullets[bi2] = true;
          hitAsteroids[ai2] = true;
          score += SCORES[ast2.size];
          explode(ast2.x, ast2.y, 6 + Math.floor(Math.random() * 5), 2.5);
          if (ast2.size === 'large') {
            newAsteroids.push(createAsteroid(ast2.x, ast2.y, 'medium', speedMult));
            newAsteroids.push(createAsteroid(ast2.x, ast2.y, 'medium', speedMult));
          } else if (ast2.size === 'medium') {
            newAsteroids.push(createAsteroid(ast2.x, ast2.y, 'small', speedMult));
            newAsteroids.push(createAsteroid(ast2.x, ast2.y, 'small', speedMult));
          }
          break;
        }
      }
    }

    bullets = bullets.filter(function (_, i) { return !hitBullets[i]; });
    asteroids = asteroids.filter(function (_, i) { return !hitAsteroids[i]; });
    for (var ni = 0; ni < newAsteroids.length; ni++) asteroids.push(newAsteroids[ni]);

    // Ship-asteroid collision
    if (ship.invincible <= 0) {
      for (var ai3 = 0; ai3 < asteroids.length; ai3++) {
        if (dist2(ship, asteroids[ai3]) < ship.radius + asteroids[ai3].radius - 4) {
          loseLife();
          break;
        }
      }
    }

    // Wave progression
    if (waveDelay > 0) {
      waveDelay -= delta;
      if (waveDelay <= 0 && asteroids.length === 0) {
        spawnWave();
      }
    }

    if (asteroids.length === 0 && waveDelay <= 0) {
      wave++;
      waveTimer = 90;
      waveDelay = 90;
    }

    if (waveTimer > 0) waveTimer -= delta;
  }

  function loseLife() {
    explode(ship.x, ship.y, 16, 4);
    lives--;
    if (lives <= 0) {
      state = STATE.GAME_OVER;
      ship = null;
      return;
    }
    ship.x = canvas.width / 2;
    ship.y = canvas.height / 2;
    ship.vx = 0;
    ship.vy = 0;
    ship.invincible = 120;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (state === STATE.START) {
      renderAsteroids(bgAsteroids);
      renderStart();
    } else if (state === STATE.PLAYING || state === STATE.PAUSED) {
      renderGame();
      if (state === STATE.PAUSED) renderPaused();
    } else if (state === STATE.GAME_OVER) {
      renderAsteroids(bgAsteroids);
      renderGameOver();
    }
  }

  function renderAsteroids(list) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.asteroid;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.rotation);
      ctx.beginPath();
      ctx.moveTo(a.verts[0].x, a.verts[0].y);
      for (var j = 1; j < a.verts.length; j++) ctx.lineTo(a.verts[j].x, a.verts[j].y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  function renderShip() {
    if (!ship) return;
    // Blink when invincible
    if (ship.invincible > 0 && Math.floor(ship.invincible / 8) % 2 === 0) return;
    ctx.save();
    ctx.translate(ship.x, ship.y);
    ctx.rotate(ship.angle);
    ctx.strokeStyle = colors.ship;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ship.radius, 0);
    ctx.lineTo(-ship.radius * 0.6, -ship.radius * 0.7);
    ctx.lineTo(-ship.radius * 0.3, 0);
    ctx.lineTo(-ship.radius * 0.6, ship.radius * 0.7);
    ctx.closePath();
    ctx.stroke();
    // Thrust flame
    if (keys['ArrowUp']) {
      ctx.strokeStyle = colors.thrust;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-ship.radius * 0.3, 0);
      ctx.lineTo(-ship.radius * (0.8 + Math.random() * 0.7), 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderBullets() {
    ctx.fillStyle = colors.bullet;
    for (var i = 0; i < bullets.length; i++) {
      ctx.beginPath();
      ctx.arc(bullets[i].x, bullets[i].y, bullets[i].radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function renderParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = colors.explosion;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawLifeIcon(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 2);
    ctx.strokeStyle = colors.ship;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.6, -r * 0.7);
    ctx.lineTo(-r * 0.3, 0);
    ctx.lineTo(-r * 0.6, r * 0.7);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function renderHUD() {
    ctx.fillStyle = colors.hud;
    ctx.font = '16px ' + colors.font;
    ctx.textAlign = 'left';
    ctx.fillText('SCORE: ' + score, 16, 36);

    for (var i = 0; i < lives; i++) {
      drawLifeIcon(canvas.width - 16 - i * 26, 28, 8);
    }

    if (waveTimer > 0) {
      var alpha = Math.min(1, waveTimer / 20);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colors.hud;
      ctx.font = '28px ' + colors.font;
      ctx.textAlign = 'center';
      ctx.fillText('WAVE ' + wave, canvas.width / 2, canvas.height / 2);
      ctx.globalAlpha = 1;
    }
  }

  function renderGame() {
    renderAsteroids(asteroids);
    renderBullets();
    renderParticles();
    renderShip();
    renderHUD();
  }

  function renderPaused() {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = colors.hud;
    ctx.font = '36px ' + colors.font;
    ctx.textAlign = 'center';
    ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2);
    ctx.font = '14px ' + colors.font;
    ctx.globalAlpha = 0.7;
    ctx.fillText('ESC to resume', canvas.width / 2, canvas.height / 2 + 36);
    ctx.globalAlpha = 1;
  }

  function renderStart() {
    var cx = canvas.width / 2, cy = canvas.height / 2;
    ctx.fillStyle = colors.start;
    ctx.font = 'bold 52px ' + colors.font;
    ctx.textAlign = 'center';
    ctx.fillText('ASTEROIDS', cx, cy - 60);

    ctx.fillStyle = colors.hud;
    ctx.font = '20px ' + colors.font;
    ctx.fillText('PRESS ENTER TO START', cx, cy);

    ctx.font = '13px ' + colors.font;
    ctx.globalAlpha = 0.65;
    ctx.fillText('← → Rotate    ↑ Thrust    SPACE Fire    ESC Pause', cx, cy + 40);
    ctx.globalAlpha = 1;
  }

  function renderGameOver() {
    var cx = canvas.width / 2, cy = canvas.height / 2;
    ctx.fillStyle = colors.gameOver;
    ctx.font = 'bold 46px ' + colors.font;
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', cx, cy - 50);

    ctx.fillStyle = colors.hud;
    ctx.font = '22px ' + colors.font;
    ctx.fillText('SCORE: ' + score, cx, cy + 4);

    ctx.font = '16px ' + colors.font;
    ctx.globalAlpha = 0.8;
    ctx.fillText('PRESS ENTER TO RESTART', cx, cy + 44);
    ctx.globalAlpha = 1;
  }

  // ── Game loop ─────────────────────────────────────────────────────────────
  function gameLoop(timestamp) {
    var delta = Math.min((timestamp - lastTime) / 16.667, 3);
    lastTime = timestamp;
    update(delta);
    render();
    requestAnimationFrame(gameLoop);
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  resize();
  readColors();
  spawnBgAsteroids();

  requestAnimationFrame(function (ts) {
    lastTime = ts;
    requestAnimationFrame(gameLoop);
  });
})();
