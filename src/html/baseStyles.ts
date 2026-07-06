export function baseStyles(): string {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      /* Neon-Noir Core Palette */
      --void: #000000;
      --surface-low: #0e0e0e;
      --surface-mid: #131313;
      --surface-high: #1a1919;
      --surface-bright: #2c2c2c;
      --primary: #ff89ab;
      --primary-container: #ff709e;
      --primary-dim: rgba(255, 137, 171, 0.25);
      --on-primary: #3d0018;
      --secondary: #00fbfb;
      --secondary-container: #003f3f;
      --secondary-dim: rgba(0, 251, 251, 0.2);
      --tertiary: #b0ff96;
      --tertiary-dim: rgba(176, 255, 150, 0.2);
      --on-secondary-container: #b0fdfd;
      --on-surface: #ffffff;
      --on-surface-variant: #adaaaa;
      --outline-variant: rgba(173, 170, 170, 0.15);
      --ghost-border: rgba(173, 170, 170, 0.08);
      --text: #ffffff;
      --muted: #adaaaa;
      --error: #ff6b6b;
      --success: #b0ff96;
      --glow: 0 0 0.6rem rgba(255, 137, 171, 0.3), 0 0 1.2rem rgba(255, 112, 158, 0.15);
      --glow-cyan: 0 0 0.6rem rgba(0, 251, 251, 0.2), 0 0 1.2rem rgba(0, 251, 251, 0.1);
      /* Compatibility aliases */
      --bg-0: #000000;
      --bg-1: #0e0e0e;
      --bg-secondary: #131313;
      --panel: rgba(14, 14, 14, 0.95);
      --panel-alt: rgba(0, 0, 0, 0.95);
      --accent-cyan: #00fbfb;
      --accent-magenta: #ff89ab;
      --accent-yellow: #ffd080;
      --danger: #ff6b6b;
      --border: rgba(173, 170, 170, 0.08);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "Inter", "Segoe UI", sans-serif;
      background: var(--surface-low);
      color: var(--on-surface-variant);
      line-height: 1.6;
      font-size: 0.875rem;
      min-height: 100vh;
      overflow-x: hidden;
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { color: var(--on-surface); text-decoration: none; }

    .navbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.5rem 1rem;
      background: var(--surface-mid);
      position: sticky;
      top: 0;
      backdrop-filter: blur(12px);
      z-index: 20;
      height: 48px;
    }
    .navbar-left { display: flex; align-items: center; gap: 0.75rem; }
    .brand {
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      font-weight: 700;
      letter-spacing: -0.02em;
      font-size: 0.95rem;
      color: var(--primary);
      text-transform: uppercase;
    }
    .navbar-daemon-slot { margin-left: auto; display: flex; justify-content: flex-end; min-width: auto; }

    /* Nav Dropdown Hamburger Menu */
    .nav-dropdown { position: relative; display: inline-block; }
    .nav-dropdown-toggle {
      background: transparent;
      border: none;
      padding: 0.25rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      min-width: 32px;
    }
    .nav-dropdown-toggle:hover { box-shadow: none; }
    .hamburger-icon {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: 20px;
    }
    .hamburger-icon span {
      display: block;
      height: 2px;
      background: var(--on-surface-variant);
      transition: background 0.15s;
    }
    .nav-dropdown-toggle:hover .hamburger-icon span { background: var(--on-surface); }
    .nav-dropdown-menu {
      display: none;
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      min-width: 180px;
      background: var(--surface-high);
      border: 1px solid var(--outline-variant);
      z-index: 100;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(12px);
    }
    .nav-dropdown.open .nav-dropdown-menu { display: block; }
    .nav-dropdown-menu a {
      display: block;
      padding: 0.6rem 0.85rem;
      font-size: 0.8rem;
      color: var(--muted);
      transition: color 0.15s, background 0.15s;
      border: none;
    }
    .nav-dropdown-menu a:hover {
      color: var(--on-surface);
      background: rgba(255, 137, 171, 0.06);
    }
    .nav-dropdown-menu a.active {
      color: var(--primary);
      background: rgba(255, 137, 171, 0.08);
      margin-left: 0;
    }

    .container { max-width: 1180px; margin: 0 auto; padding: 1.25rem 1.25rem 1.5rem; }
    .container-dashboard { max-width: none; margin: 0; padding: 0; }
    .docs-layout {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 0.85rem;
      align-items: start;
    }
    .docs-index {
      position: sticky;
      top: 4.6rem;
      max-height: calc(100vh - 5.4rem);
      overflow: auto;
    }
    .docs-index h2 { margin-top: 0; margin-bottom: 0.55rem; }
    .docs-index-nav { display: flex; flex-direction: column; gap: 0.15rem; }
    .docs-index-nav a {
      color: var(--muted);
      padding: 0.25rem 0.45rem;
      font-size: 0.78rem;
      transition: color 0.15s, background-color 0.15s;
    }
    .docs-index-nav a:hover {
      color: var(--on-surface);
      background: rgba(255, 137, 171, 0.06);
    }
    .docs-content { min-width: 0; }
    .docs-section { scroll-margin-top: 5rem; }
    .docs-section > h2 { margin-top: 0; }
    .docs-section .card { margin-bottom: 0.7rem; }
    h1, h2, h3 {
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      font-weight: 700;
      color: var(--on-surface);
    }
    h1 { margin-bottom: 0.75rem; font-size: clamp(1.55rem, 2.2vw, 2rem); letter-spacing: -0.03em; }
    h2 { margin: 1rem 0 0.5rem; font-size: clamp(1rem, 1.5vw, 1.15rem); letter-spacing: -0.02em; }
    h3 { margin: 0.75rem 0 0.35rem; color: var(--on-surface-variant); font-size: 0.875rem; letter-spacing: -0.01em; }

    .card, .stat-card, .active-task-card, .phase-stepper, .team-hero, .phase-card, .member-card, .activity-feed {
      background: var(--surface-high);
    }
    .card { padding: 1rem; margin-bottom: 0.75rem; overflow: hidden; min-width: 0; }

    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
    .stat-card { padding: 0.85rem 1rem; text-align: left; }
    .stat-value { font-family: "Space Grotesk", sans-serif; font-size: 1.5rem; font-weight: 700; color: var(--primary); }
    .stat-label { color: var(--muted); font-size: 0.6875rem; font-family: "Inter", sans-serif; letter-spacing: 0.02em; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.65rem; margin-bottom: 1rem; }
    .metric-card { padding: 0.7rem 0.75rem; background: var(--surface-bright); border: 1px solid rgba(173, 170, 170, 0.08); min-width: 0; }
    .metric-value { font-family: "Space Grotesk", sans-serif; font-size: 1.15rem; line-height: 1.1; color: var(--on-surface); font-weight: 700; letter-spacing: -0.02em; }
    .metric-label { color: var(--muted); font-size: 0.66rem; font-family: "Inter", sans-serif; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 0.25rem; }
    .daemon-card { display: flex; align-items: center; gap: 0.45rem; padding: 0.48rem 0.68rem; }
    .daemon-killswitch { width: 100%; justify-content: center; gap: 0.8rem; flex-wrap: wrap; }
    .daemon-killswitch-nav { width: auto; margin: 0; justify-content: flex-end; padding: 0.34rem 0.55rem; gap: 0.45rem; }
    .daemon-killswitch-nav .daemon-meta { min-width: auto; }
    .daemon-killswitch-nav .daemon-title { font-size: 0.72rem; letter-spacing: 0.02em; }
    .daemon-killswitch-nav .muted { font-size: 0.72rem; }
    .daemon-killswitch-nav .daemon-kill-btn { min-width: unset; width: 26px; height: 26px; font-size: 0.75rem; padding: 0; }
    .daemon-meta { min-width: 180px; }
    .daemon-title { font-family: "Space Grotesk", sans-serif; letter-spacing: 0.02em; font-size: 0.8rem; color: var(--on-surface); }
    .daemon-kill-btn { min-width: unset; width: 30px; height: 30px; font-size: 0.8rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .daemon-pausing { font-weight: 700; letter-spacing: 0.02em; }
    .dashboard-grid { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin-bottom: 0.75rem; }
    .dashboard-panel { margin-bottom: 0; }
    .dashboard-panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; margin-bottom: 0.6rem; }
    .dashboard-panel-head h2 { margin: 0; }
    .active-task-card { padding: 0.75rem 0.85rem; display: grid; grid-template-columns: 1fr; gap: 0.8rem; align-items: stretch; }
    .status-list { padding: 0.2rem 0.15rem; }
    .active-task-main { min-width: 0; }
    .active-task-head { display: flex; justify-content: space-between; align-items: center; gap: 0.45rem; margin-bottom: 0.4rem; }
    .active-task-title { display: block; font-size: 1rem; font-weight: 700; margin-bottom: 0.28rem; color: var(--primary); font-family: "Space Grotesk", sans-serif; }
    .task-queue-panel { margin-top: 0.65rem; padding: 0.45rem 0.55rem; background: var(--surface-bright); border-radius: var(--sk-radius-md); }
    .task-queue-heading { font-size: 0.6875rem; letter-spacing: 0.02em; color: var(--muted); margin-bottom: 0.35rem; }
    .task-queue-list { list-style: none; display: flex; flex-direction: column; gap: 0.35rem; }
    .task-queue-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0.45rem; align-items: center; }
    .task-queue-item a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-card-row { display: flex; flex-wrap: wrap; gap: 0.65rem; padding-bottom: 0.35rem; }
    .agent-card { min-width: 0; flex: 0 1 calc((100% - 1.95rem) / 4); max-width: calc((100% - 1.95rem) / 4); display: flex; flex-direction: column; align-items: center; gap: 0.65rem; padding: 0.95rem 0.65rem; background: var(--surface-bright); border-radius: var(--sk-radius-md); }
    .agent-card-active { box-shadow: inset 0 0 0 1px rgba(255, 137, 171, 0.2), 0 0 1.2rem rgba(0, 251, 251, 0.05); }
    .agent-card-sleep { opacity: 0.72; }
    .pixel-agent {
      width: clamp(72px, 7vw, 88px);
      height: clamp(72px, 7vw, 88px);
      position: relative;
      image-rendering: pixelated;
      filter: drop-shadow(0 0 0.5rem hsl(var(--agent-primary-h, 190) 90% 58% / 0.55)) drop-shadow(0 0 1rem hsl(var(--agent-accent-h, 315) 88% 58% / 0.35));
    }
    .pixel-agent::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(hsl(var(--agent-accent-h, 315) 88% 58%) 0 0) 29% 4%/42% 7% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 40% 26%) 0 0) 24% 10%/52% 8% no-repeat,
        linear-gradient(hsl(var(--agent-skin-h, 24) 62% 75%) 0 0) 24% 16%/52% 30% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 45% 16%) 0 0) 28% 12%/44% 6% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 45% 16%) 0 0) 34% 25%/8% 7% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 45% 16%) 0 0) 58% 25%/8% 7% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 88% 72%) 0 0) 35% 24%/6% 2% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 88% 72%) 0 0) 59% 24%/6% 2% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 32% 32%) 0 0) 43% 30%/14% 3% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 62% 62%) 0 0) 42% 36%/16% 4% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 78% 54%) 0 0) 26% 45%/48% 26% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 72% 56%) 0 0) 38% 50%/24% 5% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 78% 54%) 0 0) 17% 48%/8% 24% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 78% 54%) 0 0) 75% 48%/8% 24% no-repeat,
        linear-gradient(hsl(var(--agent-skin-h, 24) 62% 75%) 0 0) 16% 56%/8% 6% no-repeat,
        linear-gradient(hsl(var(--agent-skin-h, 24) 62% 75%) 0 0) 76% 56%/8% 6% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 48% 30%) 0 0) 26% 62%/48% 6% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 48% 34%) 0 0) 32% 71%/12% 20% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 48% 34%) 0 0) 56% 71%/12% 20% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 72% 60%) 0 0) 31% 88%/14% 8% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 72% 60%) 0 0) 55% 88%/14% 8% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 40% 14%) 0 0) 28% 92%/20% 6% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 40% 14%) 0 0) 52% 92%/20% 6% no-repeat;
    }
    .pixel-agent-awake {
      animation: pixel-agent-hero-bob 620ms steps(2, end) infinite;
    }
    .pixel-agent-awake::after {
      content: "";
      position: absolute;
      inset: -8% -10%;
      background:
        radial-gradient(circle, hsl(var(--agent-primary-h, 190) 95% 68% / 0.95) 0 28%, transparent 32%) 10% 30%/10px 10px no-repeat,
        radial-gradient(circle, hsl(var(--agent-secondary-h, 244) 90% 74% / 0.95) 0 28%, transparent 32%) 88% 22%/12px 12px no-repeat,
        radial-gradient(circle, hsl(var(--agent-accent-h, 315) 95% 66% / 0.95) 0 28%, transparent 32%) 84% 68%/10px 10px no-repeat;
      animation: pixel-agent-spark 900ms linear infinite;
      pointer-events: none;
    }
    .pixel-agent-sleep {
      filter: grayscale(0.25) brightness(0.82) drop-shadow(0 0 0.4rem rgba(200, 211, 245, 0.3));
    }
    .pixel-agent-sleep::before {
      background:
        linear-gradient(hsl(var(--agent-accent-h, 315) 30% 44%) 0 0) 29% 4%/42% 7% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 24% 22%) 0 0) 24% 10%/52% 8% no-repeat,
        linear-gradient(hsl(var(--agent-skin-h, 24) 28% 64%) 0 0) 24% 16%/52% 30% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 28% 14%) 0 0) 28% 12%/44% 6% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 28% 14%) 0 0) 34% 25%/8% 7% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 28% 14%) 0 0) 58% 25%/8% 7% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 40% 62%) 0 0) 35% 24%/6% 2% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 40% 62%) 0 0) 59% 24%/6% 2% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 18% 30%) 0 0) 43% 30%/14% 3% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 26% 34%) 0 0) 42% 36%/16% 4% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 32% 42%) 0 0) 26% 45%/48% 26% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 34% 44%) 0 0) 38% 50%/24% 5% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 32% 42%) 0 0) 17% 48%/8% 24% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 32% 42%) 0 0) 75% 48%/8% 24% no-repeat,
        linear-gradient(hsl(var(--agent-skin-h, 24) 28% 64%) 0 0) 16% 56%/8% 6% no-repeat,
        linear-gradient(hsl(var(--agent-skin-h, 24) 28% 64%) 0 0) 76% 56%/8% 6% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 22% 28%) 0 0) 26% 62%/48% 6% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 24% 30%) 0 0) 32% 71%/12% 20% no-repeat,
        linear-gradient(hsl(var(--agent-secondary-h, 244) 24% 30%) 0 0) 56% 71%/12% 20% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 34% 48%) 0 0) 31% 88%/14% 8% no-repeat,
        linear-gradient(hsl(var(--agent-accent-h, 315) 34% 48%) 0 0) 55% 88%/14% 8% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 20% 12%) 0 0) 28% 92%/20% 6% no-repeat,
        linear-gradient(hsl(var(--agent-primary-h, 190) 20% 12%) 0 0) 52% 92%/20% 6% no-repeat;
    }
    .pixel-agent-sleep::after {
      content: "Z Z";
      position: absolute;
      left: 78%;
      top: 2%;
      font-size: clamp(14px, 1.6vw, 18px);
      font-weight: 800;
      letter-spacing: 0.15em;
      color: #ffde8a;
      text-shadow: 0 0 0.45rem rgba(255, 216, 110, 0.6);
      animation: sleep-z-rise 1.5s linear infinite;
      pointer-events: none;
    }
    @keyframes pixel-agent-hero-bob {
      0%, 100% { transform: translateY(2px); }
      50% { transform: translateY(-2px); }
    }
    @keyframes pixel-agent-spark {
      0% { opacity: 0.35; transform: translateY(2px); }
      50% { opacity: 1; transform: translateY(-2px); }
      100% { opacity: 0.35; transform: translateY(2px); }
    }
    @keyframes sleep-z-rise {
      0% { opacity: 0; transform: translateY(0); }
      20% { opacity: 1; }
      100% { opacity: 0; transform: translateY(-8px); }
    }
    .status-row { display: grid; grid-template-columns: auto minmax(120px, 1fr) auto auto; align-items: center; gap: 0.5rem; padding: 0.5rem 0.35rem; }
    .status-agent { font-weight: 700; color: var(--secondary); font-family: "Space Grotesk", sans-serif; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .list-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      font-size: 0.6875rem;
      font-family: "Inter", sans-serif;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border: 1px solid rgba(173, 170, 170, 0.15);
      border-radius: var(--sk-radius-xs);
      background: var(--surface-bright);
      color: var(--muted);
    }
    .badge-idle { background: var(--surface-bright); color: var(--muted); }
    .badge-busy, .badge-running { background: rgba(0, 251, 251, 0.08); color: var(--secondary); border-color: rgba(0, 251, 251, 0.3); box-shadow: 0 0 0.6rem rgba(0, 251, 251, 0.12); }
    .badge-error, .badge-failed { background: rgba(255, 107, 107, 0.08); color: var(--error); border-color: rgba(255, 107, 107, 0.3); }
    .badge-stopped { background: rgba(173, 170, 170, 0.08); color: var(--muted); border-color: rgba(173, 170, 170, 0.2); }
    .badge-review { background: rgba(255, 200, 50, 0.08); color: #ffc832; border-color: rgba(255, 200, 50, 0.3); box-shadow: 0 0 0.6rem rgba(255, 200, 50, 0.12); }
    .badge-draft, .badge-pending { background: rgba(173, 170, 170, 0.06); color: var(--on-surface-variant); border-color: rgba(173, 170, 170, 0.2); }
    .badge-approved, .badge-completed, .badge-resolved, .badge-published { background: rgba(176, 255, 150, 0.08); color: var(--success); border-color: rgba(176, 255, 150, 0.25); }
    .badge-open { background: rgba(255, 137, 171, 0.08); color: var(--primary); border-color: rgba(255, 137, 171, 0.3); }
    .badge-system { background: rgba(0, 251, 251, 0.06); color: var(--secondary); border-color: rgba(0, 251, 251, 0.2); }
    .badge-paused { background: rgba(255, 208, 128, 0.08); color: #ffd080; border-color: rgba(255, 208, 128, 0.25); }
    .badge-default { background: var(--surface-bright); color: var(--muted); border-color: rgba(173, 170, 170, 0.15); }
    .badge-info { background: rgba(0, 251, 251, 0.05); color: var(--muted); border-color: rgba(0, 251, 251, 0.15); }
    .badge-danger { background: rgba(255, 107, 107, 0.08); color: var(--error); border-color: rgba(255, 107, 107, 0.3); }

    .muted { color: var(--muted); font-size: 0.8rem; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem; gap: 0.8rem; }

    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 2px solid rgba(173, 170, 170, 0.1); color: var(--muted); font-size: 0.6875rem; font-family: "Inter", sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
    .data-table td { padding: 0.46rem 0.5rem; border-bottom: 1px solid rgba(173, 170, 170, 0.06); vertical-align: top; }
    .data-table tbody tr { transition: background-color 0.15s; }
    .data-table tbody tr:hover { background-color: rgba(255, 137, 171, 0.03); }
    .mcp-table td { vertical-align: middle; }
    .mcp-server-name { font-weight: 600; color: var(--on-surface); }
    .mcp-details { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; max-width: 420px; }
    .mcp-command, .mcp-args {
      font-family: "JetBrains Mono", "Consolas", monospace;
      font-size: 0.73rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mcp-command { color: var(--on-surface-variant); }
    .mcp-args { color: var(--muted); }
    .mcp-toggle-cell { white-space: nowrap; }
    .mcp-table .toggle-btn { min-width: 86px; justify-content: center; border-radius: 1rem; }

    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .detail-desc { margin-top: 0.75rem; }
    .detail-desc pre {
      background: var(--void);
      overflow-x: auto;
      color: var(--on-surface-variant);
      font-family: "JetBrains Mono", "Consolas", monospace;
      border-radius: 0;
    }
    .detail-desc pre { padding: 0.6rem; font-size: 0.8rem; margin-top: 0.25rem; }
    .detail-desc-body {
      white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
      font-family: "Inter", sans-serif; font-size: 0.85rem; line-height: 1.5;
      max-height: 20lh; overflow-y: auto;
    }
    .delegation-prompt > summary { cursor: pointer; list-style: none; }
    .delegation-prompt > summary::-webkit-details-marker { display: none; }
    .delegation-prompt pre {
      margin-top: 0.35rem;
      padding: 0.45rem 0.55rem;
      background: var(--void);
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.78rem;
      line-height: 1.25;
      font-family: "JetBrains Mono", "Consolas", monospace;
    }

    button, .btn, .btn-sm, .btn-link {
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-container) 100%);
      color: var(--on-primary);
      border: none;
      padding: var(--sk-btn-pad-y) var(--sk-btn-pad-x);
      border-radius: var(--sk-btn-radius);
      cursor: pointer;
      font-family: "Inter", sans-serif;
      font-size: var(--sk-btn-font);
      font-weight: 600;
      line-height: 1.1;
      letter-spacing: 0.02em;
      transition: box-shadow 0.15s, background 0.15s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--sk-btn-height);
      white-space: nowrap;
    }
    button:hover, .btn:hover, .btn-link:hover {
      box-shadow: 0 0 1.2rem var(--primary-dim);
      color: var(--on-primary);
    }
    button:active, .btn:active { opacity: 0.85; }
    .btn-sm { padding: var(--sk-btn-pad-y-sm) var(--sk-btn-pad-x-sm); font-size: var(--sk-btn-font-sm); min-height: var(--sk-btn-height-sm); }
    .toggle-btn { padding: 0.25rem 0.65rem; font-size: 0.72rem; min-height: 1.5rem; border-radius: 1rem; cursor: pointer; transition: background 0.15s, color 0.15s; }
    .toggle-on { background: var(--running, #22c55e) !important; color: #fff !important; }
    .toggle-off { background: var(--surface-bright) !important; color: var(--muted) !important; border: 1px solid rgba(173,170,170,0.2); }
    .btn-secondary,
    .btn-danger,
    .btn-warning {
      background: var(--surface-bright);
      color: var(--on-surface-variant);
      border: 1px solid rgba(173,170,170,0.32);
      box-shadow: none;
    }
    .btn-secondary:hover,
    .btn-danger:hover,
    .btn-warning:hover {
      background: rgba(173,170,170,0.14);
      border-color: rgba(173,170,170,0.5);
      color: var(--on-surface);
      box-shadow: none;
    }
    .action-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-start; }
    .operator-actions .section-heading { margin-bottom: 0.5rem; }
    .operator-actions .iterate-form { width: 100%; }
    .operator-actions .iterate-form label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--muted); margin-bottom: 0.25rem; }
    .operator-actions .iterate-form textarea { width: 100%; padding: 0.5rem; border: 1px solid rgba(173,170,170,0.15); background: var(--surface-high); color: var(--text); font-family: inherit; font-size: 0.85rem; resize: vertical; box-sizing: border-box; margin: 0.35rem 0; }
    .artifact-detail { margin-top: 0.75rem; }
    .artifact-detail-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.25rem; }
    .artifact-detail-header h3 { margin: 0; }
    .artifact-versions { margin: 0.5rem 0; display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; font-size: 0.8rem; color: var(--muted); }
    .artifact-body { word-break: break-word; overflow-wrap: anywhere; padding: 0.75rem 1rem; margin: 0; background: var(--void); font-size: 0.85rem; line-height: 1.6; border: 1px solid rgba(173,170,170,0.08); }
    .artifact-body.artifact-raw { white-space: pre-wrap; font-family: "JetBrains Mono", "Consolas", monospace; font-size: 0.78rem; line-height: 1.45; }
    .artifact-body.artifact-raw code { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
    .artifact-rendered { font-family: "Inter", sans-serif; }
    .artifact-rendered h1, .artifact-rendered h2, .artifact-rendered h3, .artifact-rendered h4 { margin: 1rem 0 0.5rem; color: var(--text); }
    .artifact-rendered h1 { font-size: 1.3rem; border-bottom: 1px solid var(--ghost-border); padding-bottom: 0.3rem; }
    .artifact-rendered h2 { font-size: 1.1rem; border-bottom: 1px solid var(--ghost-border); padding-bottom: 0.25rem; }
    .artifact-rendered h3 { font-size: 0.95rem; }
    .artifact-rendered h1:first-child, .artifact-rendered h2:first-child, .artifact-rendered h3:first-child { margin-top: 0; }
    .artifact-rendered p { margin: 0.5rem 0; }
    .artifact-rendered ul, .artifact-rendered ol { margin: 0.5rem 0; padding-left: 1.5rem; }
    .artifact-rendered li { margin: 0.25rem 0; }
    .artifact-rendered code { background: rgba(173,170,170,0.1); padding: 0.15rem 0.35rem; font-family: "JetBrains Mono", "Consolas", monospace; font-size: 0.82rem; }
    .artifact-rendered pre { background: rgba(0,0,0,0.3); padding: 0.75rem; margin: 0.5rem 0; overflow-x: auto; }
    .artifact-rendered pre code { background: none; padding: 0; font-size: 0.8rem; line-height: 1.5; }
    .artifact-rendered blockquote { border-left: 3px solid var(--secondary); margin: 0.5rem 0; padding: 0.25rem 0.75rem; color: var(--muted); }
    .artifact-rendered table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
    .artifact-rendered th, .artifact-rendered td { border: 1px solid var(--ghost-border); padding: 0.4rem 0.6rem; text-align: left; font-size: 0.82rem; }
    .artifact-rendered th { background: rgba(173,170,170,0.05); font-weight: 600; }
    .artifact-rendered hr { border: none; border-top: 1px solid var(--ghost-border); margin: 1rem 0; }
    .artifact-rendered a { color: var(--secondary); }
    .sk-md p { margin: 0.35rem 0; }
    .sk-md p:first-child { margin-top: 0; }
    .sk-md p:last-child { margin-bottom: 0; }
    .sk-md ul, .sk-md ol { margin: 0.4rem 0; padding-left: 1.5rem; }
    .sk-md li { margin: 0.2rem 0; }
    .sk-md code { background: rgba(173,170,170,0.12); padding: 0.1rem 0.3rem; font-family: "JetBrains Mono", "Consolas", monospace; font-size: 0.82rem; }
    .sk-md pre { background: rgba(0,0,0,0.3); padding: 0.6rem; margin: 0.4rem 0; overflow-x: auto; }
    .sk-md pre code { background: none; padding: 0; }
    .sk-md blockquote { border-left: 3px solid var(--secondary); margin: 0.4rem 0; padding: 0.2rem 0.6rem; color: var(--muted); }
    .esc-q { position: relative; }
    .esc-q__body { max-height: 22em; overflow-y: auto; position: relative; }
    .note-item {
      padding: 0.7rem 0.9rem;
      background: var(--surface-mid);
      font-size: 0.85rem;
      border: 1px solid var(--outline-variant);
      border-radius: var(--sk-radius-md);
    }
    .note-item:hover {
      border-color: rgba(173, 170, 170, 0.18);
    }
    /* Subtle delete affordance: understated weight, but bright enough to read. */
    .note-item .note-action--delete { opacity: 0.45 !important; }
    .note-item:hover .note-action--delete { opacity: 0.7 !important; }
    .note-item .note-action--delete:hover { opacity: 1 !important; color: var(--sk-accent-danger, #e06) !important; }
    .note-item-user {
      background: rgba(0, 251, 251, 0.04);
      border-color: rgba(0, 251, 251, 0.18);
    }
    .note-item .note-header {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;
    }
    .note-item .note-agent {
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--on-surface-variant);
    }
    .note-item-user .note-agent { color: var(--secondary); }
    .note-item .note-time { font-size: 0.7rem; color: var(--muted); }
    .note-item .note-body {
      white-space: pre-wrap;
      line-height: 1.55;
      color: var(--on-surface);
      font-size: 0.83rem;
    }
    .btn-disabled, button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      box-shadow: none;
    }
    .card-error {
      box-shadow: inset 0 0 0 1px rgba(255, 107, 107, 0.2);
      background: rgba(255, 107, 107, 0.03);
    }
    .error { color: var(--error); font-weight: 700; }

    form label { display: block; margin-bottom: 0.65rem; color: var(--muted); font-size: 0.8rem; font-family: "Inter", sans-serif; letter-spacing: 0.01em; }
    form input, form textarea, form select {
      display: block;
      width: 100%;
      margin-top: 0.2rem;
      padding: 0.46rem 0;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--outline-variant);
      border-radius: 0;
      color: var(--on-surface);
      font-family: "Inter", sans-serif;
      font-size: 0.875rem;
      transition: border-color 0.25s;
      outline: none;
    }
    form input:focus, form textarea:focus, form select:focus {
      border-bottom-color: var(--secondary);
    }
    form select {
      padding: 0.46rem 0.3rem;
      background: var(--surface-bright);
      border: 1px solid var(--outline-variant);
    }
    form select:focus { border-color: var(--secondary); }
    .inline-form { display: flex; gap: 0.45rem; align-items: flex-end; }
    .inline-form input, .inline-form select { width: auto; min-width: 220px; }

    .hero-panel {
      padding: 1rem;
      margin-bottom: 0.75rem;
      background: var(--surface-high);
      border-radius: var(--sk-radius-md);
    }
    .compact-hero { padding: 0.75rem 1rem; }
    .eyebrow {
      margin-bottom: 0.25rem;
      color: var(--primary);
      font-family: "Inter", sans-serif;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .page-subtitle { max-width: 70ch; color: var(--muted); font-size: 0.875rem; line-height: 1.5; }
    .page-header-stack { align-items: flex-start; }
    .page-actions { display: flex; gap: 0.45rem; flex-wrap: wrap; }
    .section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.65rem; }
    .section-heading h2, .section-heading h3 { margin-top: 0; }
    .ghost-link, .back-link {
      font-family: "Inter", sans-serif;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 1.75rem;
      padding: 0.3rem 0.68rem;
      background: var(--surface-bright);
      color: var(--on-surface-variant);
      border: 1px solid rgba(173,170,170,0.32);
      box-shadow: none;
      white-space: nowrap;
    }
    .ghost-link:hover, .back-link:hover {
      background: rgba(173,170,170,0.14);
      border-color: rgba(173,170,170,0.5);
      color: var(--on-surface);
      box-shadow: none;
    }
    .back-link { display: inline-block; margin-bottom: 0.55rem; }
    .task-stats-row { margin-bottom: 0; }
    .task-table { table-layout: fixed; }
    .task-table th:nth-child(1), .task-table td:nth-child(1) { width: 9%; }
    .task-table th:nth-child(2), .task-table td:nth-child(2) { width: 33%; }
    .task-table th:nth-child(3), .task-table td:nth-child(3) { width: 16%; }
    .task-table th:nth-child(4), .task-table td:nth-child(4) { width: 8%; }
    .task-table th:nth-child(5), .task-table td:nth-child(5) { width: 12%; }
    .task-table th:nth-child(6), .task-table td:nth-child(6) { width: 11%; }
    .task-table th:nth-child(7), .task-table td:nth-child(7) { width: 11%; }
    .task-row-title a { font-weight: 600; color: var(--primary); }
    .task-row-description { margin-top: 0.2rem; line-height: 1.45; }
    .table-actions { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
    .action-dropdown { position: relative; display: inline-block; }
    .action-dropdown-toggle { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: var(--sk-btn-pad-y-sm) var(--sk-btn-pad-x-sm); font-size: var(--sk-btn-font-sm); min-height: var(--sk-btn-height-sm); background: var(--surface-bright); color: var(--on-surface-variant); border: 1px solid rgba(173,170,170,0.32); border-radius: var(--sk-btn-radius); white-space: nowrap; box-shadow:none; }
    .action-dropdown-toggle:hover { background: rgba(173,170,170,0.14); border-color: rgba(173,170,170,0.5); color: var(--on-surface); box-shadow:none; }
    .action-dropdown-toggle::after { content: " \u25BE"; font-size: 0.6rem; }
    .action-dropdown-menu { display: none; position: absolute; right: 0; top: 100%; margin-top: 2px; min-width: 130px; background: var(--surface-bright); border: 1px solid var(--outline-variant); border-radius: var(--sk-radius-sm); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6); z-index: 100; overflow: hidden; backdrop-filter: blur(12px); }
    .action-dropdown:focus-within .action-dropdown-menu { display: block; }
    .action-dropdown-menu button, .action-dropdown-menu a { display: block; width: 100%; padding: 0.42rem 0.68rem; font-size: 0.75rem; line-height: 1.15; text-align: left; background: transparent; border: none; border-radius: 0; color: var(--on-surface-variant); cursor: pointer; text-decoration: none; box-shadow: none; }
    .action-dropdown-menu button:hover, .action-dropdown-menu a:hover { background: rgba(255, 137, 171, 0.06); color: var(--on-surface); }
    .action-dropdown-menu .action-danger { color: var(--error); }
    .action-dropdown-menu .action-danger:hover { background: rgba(255, 107, 107, 0.1); }
    .action-dropdown-menu .action-divider { height: 1px; background: var(--outline-variant); margin: 2px 0; }
    .task-create-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.75rem; align-items: start; }
    .task-form-card { margin-bottom: 0; }
    .task-editor-form { display: grid; gap: 0.8rem; }
    .task-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; }
    .task-form-grid label > span { display: block; font-size: 0.75rem; font-weight: 600; color: var(--muted); font-family: "Inter", sans-serif; }
    .task-form-span-2 { grid-column: 1 / -1; }
    .task-create-aside { margin-bottom: 0; }
    .compact-list { padding-left: 1rem; color: var(--text); display: grid; gap: 0.45rem; font-size: 0.875rem; line-height: 1.5; }
    .form-actions { display: flex; justify-content: flex-end; align-items: center; gap: 0.55rem; }
    .task-instance-page { display: grid; gap: 0.75rem; }
    .task-instance-hero { margin-bottom: 0; }
    .task-instance-hero-head { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, 0.8fr); align-items: start; gap: 1rem; }
    .task-instance-hero-primary { min-width: 0; display: grid; gap: 0.7rem; }
    .task-instance-hero-meta { display: flex; flex-wrap: wrap; gap: 0.35rem; justify-content: flex-start; }
    .task-instance-hero-phase {
      min-width: 0;
      padding: 0.85rem 0.95rem;
      background: var(--surface-bright);
      border: 1px solid rgba(173, 170, 170, 0.12);
    }
    .task-instance-hero-phase .phase-stepper { margin: 0; padding: 0; background: transparent; }
    .task-instance-hero-phase .task-phase-fallback { padding: 0; }
    .task-instance-chip {
      display: inline-flex;
      align-items: center;
      min-height: 1.35rem;
      padding: 0 0.45rem;
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--muted);
      border: 1px solid rgba(173, 170, 170, 0.2);
      background: var(--surface-bright);
    }
    .task-instance-layout { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, 1fr); gap: 0.75rem; align-items: start; }
    .task-instance-main, .task-instance-rail { display: grid; gap: 0.75rem; align-content: start; min-width: 0; }
    .task-instance-summary-card { padding: 0.85rem; }
    .task-inline-edit-toggle { position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none; }
    .task-inline-edit-form { display: none; }
    .task-edit-close { display: none; }
    .task-inline-edit-toggle:checked ~ .task-instance-main .task-inline-edit-display { display: none; }
    .task-inline-edit-toggle:checked ~ .task-instance-main .task-inline-edit-form { display: grid; }
    .task-inline-edit-toggle:checked ~ .task-instance-rail .task-edit-open { display: none; }
    .task-inline-edit-toggle:checked ~ .task-instance-rail .task-edit-close { display: inline-flex; }
    .task-instance-summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.55rem;
      margin-bottom: 0.7rem;
    }
    .task-instance-summary-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.55rem 0.6rem;
      background: var(--surface-bright);
      border: 1px solid rgba(173, 170, 170, 0.12);
    }
    .task-instance-summary-label {
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 600;
    }
    .task-instance-summary-value { font-size: 0.82rem; color: var(--on-surface-variant); }
    .task-instance-block + .task-instance-block { margin-top: 0.6rem; }
    .task-instance-block h3 { margin: 0 0 0.35rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .task-instance-block pre {
      margin: 0;
      padding: 0.65rem;
      background: var(--void);
      border: 1px solid rgba(173, 170, 170, 0.1);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "Inter", sans-serif;
      color: var(--on-surface-variant);
    }
    .task-instance-notes-scroll {
      max-height: 24rem;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-right: 0.2rem;
    }
    .task-instance-notes-list { display: grid; gap: 0.6rem; }
    .task-phase-fallback { padding: 0.25rem 0; color: var(--on-surface-variant); font-size: 0.84rem; }

    .terminal {
      background: var(--void);
      border-radius: 0;
      padding: 0.42rem;
      max-height: 500px;
      overflow-y: auto;
      font-family: "JetBrains Mono", "Consolas", monospace;
      font-size: 0.74rem;
      line-height: 1.25;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .terminal-line { padding: 0; margin: 0; }
    .terminal-stdout { color: var(--on-surface-variant); }
    .terminal-stderr { color: var(--error); }
    .terminal-json {
      margin: 0.04rem 0;
      padding: 0.16rem 0.24rem;
      border-radius: 0;
      background: var(--surface-high);
      color: var(--on-surface-variant);
      white-space: normal;
    }
    .terminal-json-header { display: flex; align-items: center; gap: 0.22rem; margin-bottom: 0.04rem; flex-wrap: wrap; }
    .badge-json-type { background: rgba(0, 251, 251, 0.06); color: var(--secondary); border-color: rgba(0, 251, 251, 0.2); }
    .terminal-json-summary { color: var(--muted); font-size: 0.74rem; line-height: 1.2; }
    .terminal-json-details { margin: 0; line-height: 1; }
    .terminal-json-details > summary { cursor: pointer; color: var(--muted); font-size: 0.6875rem; letter-spacing: 0.01em; list-style: none; }
    .terminal-json-details > summary::-webkit-details-marker { display: none; }
    .terminal-json-body {
      margin: 0.12rem 0 0;
      background: var(--void);
      border: 1px solid var(--ghost-border);
      padding: 0.22rem 0.3rem;
      overflow-x: auto;
      white-space: pre;
      word-break: normal;
      font-size: 0.72rem;
      line-height: 1.18;
    }

    .escalation-card { margin-bottom: 0.75rem; }
    .escalation-header { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .escalation-question { margin-bottom: 0.5rem; }
    .escalation-response { margin-top: 0.5rem; padding: 0.5rem; background: rgba(176, 255, 150, 0.04); border-left: 2px solid rgba(176, 255, 150, 0.3); border-radius: 0; }
    .escalation-form textarea { margin-bottom: 0.5rem; }

    .phase-stepper { margin: 1rem 0; padding: 0.95rem; }
    .phase-summary { display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 0.8rem; margin-bottom: 0.52rem; }
    .phase-progress { width: 100%; height: 2px; background: var(--surface-bright); overflow: hidden; margin-bottom: 0.86rem; }
    .phase-progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%); transition: width 0.25s ease; box-shadow: 0 0 0.8rem rgba(255, 137, 171, 0.3); }
    .phase-grid { display: grid; grid-template-columns: repeat(var(--phase-cols, 3), minmax(0, 1fr)); gap: 0.58rem; }
    .phase-step { display: flex; flex-direction: column; align-items: flex-start; gap: 0.46rem; padding: 0.62rem 0.68rem; background: var(--surface-bright); border-radius: var(--sk-radius-md); min-width: 0; }
    .phase-circle { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-family: "Space Grotesk", sans-serif; font-size: 0.75rem; font-weight: 700; border-radius: 50%; }
    .phase-name { font-size: 0.8rem; line-height: 1.3; overflow-wrap: anywhere; }
    .phase-step-done { background: rgba(176, 255, 150, 0.04); box-shadow: inset 0 0 0 1px rgba(176, 255, 150, 0.15); }
    .phase-step-done .phase-circle { background: rgba(176, 255, 150, 0.12); color: var(--success); }
    .phase-step-active { background: rgba(0, 251, 251, 0.05); box-shadow: inset 0 0 0 1px rgba(0, 251, 251, 0.2); }
    .phase-step-active .phase-circle { background: rgba(0, 251, 251, 0.1); color: var(--secondary); }
    .phase-step-pending { background: var(--surface-bright); }
    .phase-step-pending .phase-circle { background: var(--surface-high); color: var(--muted); }
    .phase-step-failed { background: rgba(255, 107, 107, 0.04); box-shadow: inset 0 0 0 1px rgba(255, 107, 107, 0.15); }
    .phase-step-failed .phase-circle { background: rgba(255, 107, 107, 0.1); color: var(--error); }
    .phase-step-review { background: rgba(255, 200, 50, 0.06); box-shadow: inset 0 0 0 1px rgba(255, 200, 50, 0.25); }
    .phase-step-review .phase-circle { background: rgba(255, 200, 50, 0.12); color: #ffc832; }

    .phase-review-dot { color: #ffc832; font-size: 0.5rem; vertical-align: super; margin-left: 2px; }
    .phase-review-toggle { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: var(--muted); cursor: pointer; margin: 0; }
    .phase-review-toggle input[type="checkbox"] { display: inline-block; width: auto; margin: 0; accent-color: #ffc832; }
    .review-banner { background: rgba(255, 200, 50, 0.08); border: 1px solid rgba(255, 200, 50, 0.25); border-radius: var(--sk-radius-md); padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
    .review-banner-title { color: #ffc832; font-weight: 600; font-size: 0.85rem; margin: 0 0 0.25rem 0; }
    .review-banner-text { color: var(--muted); font-size: 0.8rem; margin: 0; }

    .loading-bar {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 2px;
      background: transparent;
      z-index: 9999;
      pointer-events: none;
    }
    .htmx-request .loading-bar, .htmx-request.loading-bar {
      background: linear-gradient(90deg, var(--primary) 0%, var(--secondary) 50%, var(--primary) 100%);
      background-size: 200% 100%;
      animation: loading-slide 1.3s linear infinite;
      box-shadow: 0 0 0.6rem rgba(255, 137, 171, 0.4);
    }
    @keyframes loading-slide { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    .session-selector { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
    .session-selector select { width: auto; display: inline-block; }
    .empty-state { text-align: center; padding: 1.25rem 0.8rem; color: var(--muted); }
    .empty-state-icon { font-size: 1.7rem; margin-bottom: 0.3rem; opacity: 0.5; }
    .empty-state p { margin: 0.2rem 0; }

    .activity-feed { padding: 0.5rem 0.75rem; min-height: 60px; }
    .activity-feed-rich { background: var(--surface-high); }
    .activity-entry { display: flex; align-items: baseline; gap: 0.45rem; padding: 0.45rem 0; flex-wrap: wrap; }
    .activity-entry-rich { align-items: center; padding: 0.45rem 0.08rem; }
    .activity-agent { font-weight: 700; color: var(--secondary); font-size: 0.84rem; flex-shrink: 0; font-family: "Space Grotesk", sans-serif; }
    .activity-data { color: var(--on-surface-variant); font-size: 0.77rem; font-family: "JetBrains Mono", "Consolas", monospace; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .activity-time { flex-shrink: 0; }
    .badge-stream-stdout { background: rgba(0, 251, 251, 0.06); color: var(--secondary); border-color: rgba(0, 251, 251, 0.2); }
    .badge-stream-stderr { background: rgba(255, 107, 107, 0.06); color: var(--error); border-color: rgba(255, 107, 107, 0.2); }
    .logs-filter-card { padding: 0.85rem 0.9rem; }
    .logs-filter-form { gap: 0.7rem 0.9rem; align-items: flex-end; }
    .logs-filter-field { margin-bottom: 0; min-width: 210px; }
    .logs-filter-field select { width: 100%; min-width: 0; }
    .logs-filter-actions { display: flex; align-items: center; gap: 0.55rem; padding-bottom: 0.05rem; }

    .logs-feed { padding: 0; overflow: hidden; }
    .logs-feed-toolbar { display: flex; align-items: center; gap: 0.8rem; padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--outline-variant); background: linear-gradient(180deg, var(--surface-bright), var(--surface-high)); flex-wrap: wrap; }
    .logs-feed-meta { font-size: 0.76rem; flex: 1; min-width: 240px; line-height: 1.35; }
    .logs-live-toggle { display: inline-flex; align-items: center; gap: 0.36rem; font-size: 0.76rem; color: var(--muted); margin-bottom: 0; }
    .logs-live-toggle input { width: auto; margin: 0; }
    .logs-feed-body { max-height: 70vh; overflow: auto; overscroll-behavior: contain; padding: 0.2rem 0.45rem 0.45rem; }
    .logs-table { table-layout: fixed; width: 100%; margin: 0; border-collapse: collapse; }
    .logs-table thead th { position: sticky; top: 0; z-index: 1; background: var(--surface-bright); }
    .logs-table th, .logs-table td { padding: 0.58rem 0.6rem; }
    .logs-table th:nth-child(1), .logs-table td:nth-child(1) { width: 16%; vertical-align: top; }
    .logs-table th:nth-child(2), .logs-table td:nth-child(2) { width: 11%; vertical-align: top; }
    .logs-table th:nth-child(3), .logs-table td:nth-child(3) { width: 57%; vertical-align: top; }
    .logs-table th:nth-child(4), .logs-table td:nth-child(4) { width: 16%; vertical-align: top; }
    .logs-table td:nth-child(3) { overflow-wrap: anywhere; word-break: break-word; }
    .logs-table tbody tr:hover { background: rgba(0, 251, 251, 0.03); }
    .log-json-list { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; max-width: 100%; }
    .log-json-event { background: rgba(255, 255, 255, 0.01); border: 1px solid var(--outline-variant); overflow: hidden; }
    .log-json-head { display: flex; align-items: center; gap: 0.35rem; padding: 0.28rem 0.4rem; background: var(--surface-bright); flex-wrap: wrap; }
    .log-message-text { margin: 0; padding: 0.5rem 0.6rem; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-size: 0.81rem; line-height: 1.45; color: var(--text); background: transparent; border-top: 1px solid var(--outline-variant); }
    .log-json-raw > summary { cursor: pointer; padding: 0.2rem 0.5rem; font-size: 0.6875rem; letter-spacing: 0.01em; color: var(--muted); background: var(--surface-bright); border-top: 1px solid var(--outline-variant); }
    .log-json-body { margin: 0; padding: 0.42rem 0.5rem; max-height: 320px; overflow: auto; font-size: 0.74rem; line-height: 1.2; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background: var(--void); color: var(--text); }
    .log-payload-plain { margin: 0; padding: 0.42rem 0.5rem; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background: var(--void); font-size: 0.74rem; line-height: 1.2; font-family: "JetBrains Mono", "Consolas", monospace; border: 1px solid var(--outline-variant); }

    .terminal-section-header { display: flex; align-items: center; gap: 1rem; margin: 1.2rem 0 0.45rem; }
    .terminal-section-header h2 { margin: 0; }
    .terminal-line-count { font-size: 0.8rem; }

    .team-hero { margin: 0.5rem 0 1rem; padding: 1rem; }
    .team-hero h1 { margin: 0 0 0.4rem; }
    .team-hero-meta { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .team-layout { display: grid; grid-template-columns: 1.25fr 1fr; gap: 1rem; margin-bottom: 1rem; }
    .team-create-layout { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 1rem; }
    .team-create-form h3 { margin: 0.2rem 0 0.25rem; }
    .team-create-divider { height: 1px; margin: 0.35rem 0 0.55rem; background: var(--outline-variant); }
    .team-section { margin-bottom: 1rem; }
    .team-section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.55rem; }
    .team-section-header h2 { margin: 0; }
    .badge-phase-index { background: rgba(0, 251, 251, 0.06); color: var(--secondary); border-color: rgba(0, 251, 251, 0.2); }

    .phase-card-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0.75rem; }
    .phase-card { padding: 0.7rem; }
    .phase-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
    .phase-edit-form label { margin-bottom: 0.55rem; }
    .phase-edit-form textarea { min-height: 86px; resize: vertical; }
    .phase-card-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .phase-add { margin-top: 0.95rem; padding-top: 0.8rem; }

    .member-card-list { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1rem; }
    .member-card { padding: 0.95rem; }
    .member-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
    .member-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.55rem; }
    .member-grid label { margin-bottom: 0.4rem; }
    .member-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }
    .team-edit-actions { display: flex; justify-content: flex-end; margin: 0.2rem 0 1rem; }

    .forensics-panel { margin: 1rem 0; }
    .forensics-summary { cursor: pointer; display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 0.95rem; background: var(--surface-high); border-radius: 0; list-style: none; }
    .forensics-summary::-webkit-details-marker { display: none; }
    .forensics-panel[open] .forensics-summary { border-radius: 0; }
    .forensics-panel[open] .forensics-toggle-icon { transform: rotate(90deg); }
    .forensics-toggle-icon { display: inline-block; font-size: 0.7rem; transition: transform 0.2s; color: var(--primary); }
    .forensics-body { padding: 0.75rem 0.95rem; background: var(--surface-high); border-radius: 0; }
    .forensics-section { margin-bottom: 1rem; }
    .forensics-section:last-child { margin-bottom: 0; }
    .forensics-section h3 { margin: 0 0 0.5rem; }
    .forensics-timeline { border-left: 2px solid var(--outline-variant); margin-left: 0.5rem; padding-left: 0.75rem; }
    .forensics-timeline-entry { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.45rem 0; }
    .forensics-time { flex-shrink: 0; font-size: 0.78rem; color: var(--muted); min-width: 70px; }
    .forensics-icon { flex-shrink: 0; font-size: 0.85rem; }
    .forensics-label { font-size: 0.84rem; flex: 1; min-width: 0; }
    .forensics-snapshot pre { max-height: 200px; overflow-y: auto; font-size: 0.75rem; padding: 0.5rem; margin-top: 0.25rem; background: var(--void); white-space: pre-wrap; word-break: break-word; font-family: "JetBrains Mono", "Consolas", monospace; }
    .forensics-instance-node { display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0; flex-wrap: wrap; }
    .forensics-tail { max-height: 200px; overflow-y: auto; margin: 0; }

    /* --- Command Center Dashboard --- */
    .cmd-dashboard-page { width: 100vw; margin-left: calc(50% - 50vw); height: calc(100vh - 48px); padding: 1rem 1.1rem; overflow: hidden; }
    .cmd-center { max-width: 1320px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 0.2rem; height: 100%; overflow: hidden; }
    .cmd-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; }
    .cmd-title { font-family: "Space Grotesk", sans-serif; font-size: 1.6rem; font-weight: 700; letter-spacing: -0.04em; color: var(--on-surface); margin: 0; }
    .cmd-subtitle { font-size: 0.78rem; color: var(--muted); font-family: "Inter", sans-serif; }
    .cmd-daemon-pill { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.25rem 0.65rem; background: var(--surface-high); font-size: 0.72rem; font-family: "JetBrains Mono", monospace; color: var(--muted); }
    .cmd-daemon-dot { width: 6px; height: 6px; display: inline-block; }
    .cmd-daemon-dot-running { background: var(--tertiary); box-shadow: 0 0 6px var(--tertiary); }
    .cmd-daemon-dot-paused { background: var(--accent-yellow); }
    .cmd-daemon-dot-stopped { background: var(--error); }

    .cmd-metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: var(--outline-variant); margin-bottom: 0.75rem; }
    .cmd-metric { background: var(--surface-high); padding: 0.85rem 1rem; display: flex; flex-direction: column; gap: 0.2rem; }
    .cmd-metric-value { font-family: "Space Grotesk", sans-serif; font-size: 1.75rem; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
    .cmd-metric-label { font-size: 0.65rem; font-family: "Inter", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .cmd-metric-value-primary { color: var(--primary); }
    .cmd-metric-value-secondary { color: var(--secondary); }
    .cmd-metric-value-tertiary { color: var(--tertiary); }
    .cmd-metric-value-muted { color: var(--muted); }
    .cmd-metric-value-error { color: var(--error); }

    .cmd-header { margin-bottom: 0.45rem; min-height: 24px; }
    .cmd-layout { min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; align-items: start; }
    .cmd-dashboard-page-idle .cmd-center { align-items: center; justify-content: flex-start; padding-top: 0.3rem; }
    .cmd-dashboard-page-idle .cmd-layout {
      width: min(660px, calc(100vw - 1.5rem));
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      justify-content: flex-start;
      align-items: stretch;
    }
    .cmd-dashboard-page-idle .cmd-col-1 {
      width: 100%;
      max-width: 660px;
      gap: 0;
    }
    .cmd-dashboard-page-idle .cmd-layout-focus {
      min-height: 0;
      width: 100%;
    }
    .cmd-col { min-height: 0; display: flex; flex-direction: column; gap: 0.8rem; overflow: hidden; flex: 1; }
    .cmd-col-1 { min-width: 0; overflow-y: auto; max-height: 100%; }
    .cmd-col-2 { min-width: 0; overflow: hidden; height: 100%; }
    .cmd-layout-focus { min-width: 0; min-height: 0; flex: 0 0 auto; }
    .cmd-layout-queue { min-width: 0; min-height: 0; flex: 0 0 auto; }
    .cmd-layout-agents { min-width: 0; min-height: 0; flex: 1; overflow-y: auto; }
    .cmd-layout-phase { min-width: 0; flex: 0 0 auto; }
    .cmd-layout-escalations { min-width: 0; flex: 0 0 auto; max-height: 180px; overflow-y: auto; }
    .cmd-layout-delegations { min-width: 0; flex: 0 0 auto; }
    .cmd-col2-panel, .cmd-col3-panel { min-height: 0; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .cmd-layout-rt-controls { min-width: 0; flex: 0 0 auto; }

    /* Notes and Artifacts panels with internal scroll */
    .cmd-layout-notes, .cmd-layout-artifacts { min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .cmd-layout-notes .cmd-panel-body, .cmd-layout-artifacts .cmd-panel-body { flex: 1; overflow-y: auto; min-height: 0; }
    .cmd-panel { min-height: 0; display: flex; flex-direction: column; }
    .cmd-panel-body, .cmd-panel-body-flush { min-height: 0; }
    .cmd-scroll-compact { max-height: none; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
    #running-instances { overflow-y: auto; overscroll-behavior: contain; }
    .cmd-notes-body { margin: 0; white-space: pre-wrap; line-height: 1.45; font-size: 0.8rem; color: var(--on-surface-variant); }
    .dashboard-activity-modal-dialog { width: min(1280px, 97vw); }
    .cmd-dashboard-activity-trigger { margin-bottom: 0.6rem; display: flex; justify-content: flex-end; }
    .cmd-inline-intake {
      background: linear-gradient(180deg, rgba(255, 137, 171, 0.08), rgba(0, 251, 251, 0.03));
      border: 1px solid rgba(255, 137, 171, 0.22);
      padding: 0.95rem;
      position: relative;
      overflow: hidden;
    }
    .cmd-inline-intake::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: linear-gradient(180deg, var(--primary), var(--secondary));
    }
    .cmd-inline-intake-head { margin-bottom: 0.55rem; }
    .cmd-inline-intake-title {
      margin: 0;
      font-family: "Space Grotesk", sans-serif;
      font-size: 1rem;
      letter-spacing: -0.02em;
      color: var(--on-surface);
    }
    .cmd-inline-intake-form { display: grid; gap: 0.55rem; }
    .cmd-inline-intake-description input[type="text"],
    .cmd-inline-intake-description textarea {
      margin-top: 0.35rem;
      width: 100%;
      padding: 0.45rem 0.5rem;
      background: rgba(0, 0, 0, 0.32);
      border: 1px solid rgba(173, 170, 170, 0.22);
      color: var(--on-surface);
      font-size: 0.83rem;
    }
    .cmd-inline-intake-description textarea {
      resize: vertical;
      min-height: 92px;
    }
    .cmd-inline-intake-controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.2rem 0.55rem;
    }
    .cmd-inline-intake-controls label,
    .cmd-inline-intake-controls span { font-size: 0.78rem; margin-bottom: 0; }
    .cmd-inline-intake-controls select,
    .cmd-inline-intake-submit {
      align-self: stretch;
      width: 100%;
      margin-top: 0;
    }
    .cmd-inline-intake-submit {
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      font-size: 0.8rem;
      min-height: 0;
    }
    .cmd-inline-intake-meta {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
      font-size: 0.72rem;
    }
    .artifact-modal { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.72); align-items: center; justify-content: center; padding: 0.5rem; }
    .artifact-modal-dialog { width: 99vw; height: 98vh; max-width: none; max-height: none; background: var(--surface-high); display: flex; flex-direction: column; border: 1px solid rgba(173,170,170,0.18); border-radius: var(--sk-radius-lg); }
    .artifact-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 0.65rem 0.85rem; background: var(--surface-bright); border-bottom: 1px solid rgba(173,170,170,0.12); }
    .artifact-modal-title { margin: 0; font-size: 0.9rem; }
    .artifact-modal-body { padding: 1rem 1.25rem; overflow: auto; flex: 1; min-height: 0; }

    .cmd-panel { background: var(--surface-high); padding: 0; overflow: hidden; border: 1px solid rgba(173, 170, 170, 0.14); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02); }
    .cmd-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0.95rem; background: var(--surface-bright); border-bottom: 1px solid rgba(173, 170, 170, 0.08); }
    .cmd-panel-title { font-family: "Space Grotesk", sans-serif; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--on-surface-variant); }
    .cmd-panel-count { font-family: "JetBrains Mono", monospace; font-size: 0.7rem; color: var(--muted); }
    .cmd-panel-body { padding: 0.9rem 0.95rem; }
    .cmd-panel-body-flush { padding: 0; }
    .cmd-progress-header { background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0)); }
    .cmd-progress-stats { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; justify-content: flex-end; }
    .cmd-progress-stat,
    .cmd-progress-value {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.67rem;
      color: var(--muted);
      letter-spacing: 0.01em;
    }
    .cmd-layout-progress {
      flex: 0 0 252px;
      height: 252px;
      min-height: 252px;
      max-height: 252px;
    }
    .cmd-progress-grid {
      display: flex;
      flex-direction: column;
      gap: 0;
      min-height: 0;
      height: calc(100% - 46px);
    }
    .cmd-progress-phase-wrap { border-bottom: 1px solid rgba(173, 170, 170, 0.08); }
    .cmd-progress-phase-body { padding: 0.1rem 0.75rem 0.6rem; }
    .cmd-progress-columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      min-height: 0;
      flex: 1 1 auto;
    }
    .cmd-progress-section { min-width: 0; display: flex; flex-direction: column; }
    .cmd-progress-columns .cmd-progress-section + .cmd-progress-section { border-left: 1px solid rgba(173, 170, 170, 0.08); }
    .cmd-progress-section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
      padding: 0.64rem 0.75rem 0.44rem;
    }
    .cmd-progress-section-head-phase { padding-bottom: 0.38rem; }
    .cmd-progress-label {
      font-family: "Space Grotesk", sans-serif;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--on-surface-variant);
    }
    .cmd-progress-section-body {
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      flex: 1 1 auto;
    }
    #running-instances, #dashboard-delegations { min-height: 0; }
    .cmd-phase-inline {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      min-width: 0;
      white-space: nowrap;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      padding: 0.02rem 0 0;
    }
    .cmd-phase-inline-index {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.64rem;
      color: var(--secondary);
      flex-shrink: 0;
      padding: 0 0.04rem 0 0;
    }
    .cmd-phase-inline-steps { display: flex; align-items: center; gap: 0.28rem; min-width: 0; }
    .cmd-phase-pill {
      display: inline-flex;
      align-items: center;
      padding: 0.18rem 0.34rem;
      font-family: "JetBrains Mono", monospace;
      font-size: 0.58rem;
      color: var(--muted);
      border: 1px solid rgba(173, 170, 170, 0.14);
      background: rgba(255, 255, 255, 0.01);
    }
    .cmd-phase-pill-active { color: var(--secondary); border-color: rgba(0, 251, 251, 0.28); background: rgba(0, 251, 251, 0.06); }
    .cmd-phase-pill-done { color: var(--on-surface-variant); border-color: rgba(173, 170, 170, 0.18); }
    .cmd-phase-pill-review { color: #ffc832; border-color: rgba(255, 200, 50, 0.28); background: rgba(255, 200, 50, 0.06); }

    /* Focus task hero */
    .cmd-focus { padding: 1rem; background: var(--surface-high); position: relative; overflow: hidden; }
    .cmd-focus::before { content: ""; position: absolute; top: 0; left: 0; width: 3px; height: 100%; background: linear-gradient(180deg, var(--primary), var(--secondary)); }
    .cmd-focus-empty { padding: 2rem 1rem; text-align: center; }
    .cmd-focus-empty::before { display: none; }
    .cmd-focus-eyebrow { font-size: 0.65rem; font-family: "Inter", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: var(--primary); margin-bottom: 0.35rem; }
    .cmd-focus-title { font-family: "Space Grotesk", sans-serif; font-size: 1.2rem; font-weight: 700; letter-spacing: -0.02em; color: var(--on-surface); margin-bottom: 0.35rem; }
    .cmd-focus-meta { display: flex; gap: 0.45rem; align-items: center; flex-wrap: wrap; }
    .cmd-focus-actions { margin-top: 0.75rem; }
    .cmd-steer-header { align-items: center; gap: 0.8rem; }
    .cmd-layout-steer-active {
      flex: 1 1 280px;
      min-height: 280px;
      height: auto;
      max-height: none;
    }
    .cmd-layout-steer-inactive {
      flex: 0 0 72px;
      height: 72px;
      min-height: 72px;
      max-height: 72px;
    }
    .cmd-steer-body {
      padding: 0.5rem 0.75rem;
      min-height: 0;
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .cmd-dashboard-steer-form {
      display: grid;
      gap: 0.55rem;
      height: 100%;
      min-height: 0;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    .cmd-steer-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.55rem; align-items: end; }
    .cmd-steer-field { display: grid; gap: 0.4rem; margin: 0; }
    .cmd-steer-field-message {
      min-height: 0;
      overflow: hidden;
      align-content: stretch;
    }
    .cmd-steer-label {
      font-family: "Space Grotesk", sans-serif;
      font-size: 0.67rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--on-surface-variant);
    }
    .cmd-dashboard-steer-form input,
    .cmd-dashboard-steer-form select,
    .cmd-dashboard-steer-form textarea {
      width: 100%;
      padding: 0.52rem 0.62rem;
      border: 1px solid rgba(173, 170, 170, 0.2);
      background: rgba(0, 0, 0, 0.28);
      color: var(--on-surface);
      font-size: 0.76rem;
      outline: none;
      font-family: "Inter", sans-serif;
      transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
      resize: vertical;
    }
    .cmd-dashboard-steer-form textarea {
      min-height: 140px;
      height: 100%;
      max-height: none;
      resize: none;
      overflow: auto;
    }
    .cmd-dashboard-steer-form select:focus,
    .cmd-dashboard-steer-form textarea:focus,
    .cmd-dashboard-steer-form input:focus {
      border-color: rgba(0, 251, 251, 0.5);
      box-shadow: 0 0 0 1px rgba(0, 251, 251, 0.18);
      background: rgba(0, 0, 0, 0.34);
    }
    .cmd-steer-actions-row { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
    .cmd-steer-status {
      margin: 0;
      font-size: 0.74rem;
      max-width: 32rem;
      min-height: 0;
      overflow-wrap: anywhere;
    }
    .cmd-steer-empty {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      width: 100%;
      height: 100%;
    }
    .cmd-steer-empty-text {
      margin: 0;
      font-size: 0.76rem;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cmd-steer-empty .btn-sm { flex-shrink: 0; }

    /* RT controls card */
    .cmd-rt-controls-body { display: flex; flex-direction: column; gap: 0.55rem; }
    .cmd-rt-start-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .cmd-rt-compose { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: center; }
    .cmd-rt-compose input {
      width: 100%;
      padding: 0.58rem 0.7rem;
      border: 1px solid rgba(173, 170, 170, 0.2);
      background: rgba(0, 0, 0, 0.32);
      color: var(--on-surface);
      font-size: 0.82rem;
      outline: none;
      font-family: "Inter", sans-serif;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    .cmd-rt-compose input:focus {
      border-color: rgba(0, 251, 251, 0.5);
      box-shadow: 0 0 0 1px rgba(0, 251, 251, 0.2);
    }
    .cmd-rt-send-btn {
      min-width: 78px;
      background: linear-gradient(180deg, rgba(0, 251, 251, 0.2), rgba(0, 251, 251, 0.08));
      border-color: rgba(0, 251, 251, 0.45);
      color: var(--secondary);
      font-weight: 600;
    }
    .cmd-rt-recorder { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .cmd-rt-record-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      background: linear-gradient(180deg, rgba(255, 137, 171, 0.24), rgba(255, 137, 171, 0.1));
      border-color: rgba(255, 137, 171, 0.46);
      color: var(--primary);
      font-weight: 600;
    }
    .cmd-rt-stop-btn { display: inline-flex; align-items: center; gap: 0.35rem; }
    .cmd-rt-status { font-size: 0.72rem; }
    .cmd-rt-visualizer-wrap { margin-top: 0.35rem; }
    .cmd-rt-visualizer {
      width: 100%;
      height: 48px;
      background: var(--void);
      border: 1px solid rgba(173, 170, 170, 0.15);
    }

    /* Task queue */
    .cmd-queue-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.85rem; transition: background 0.1s; }
    .cmd-queue-item:hover { background: rgba(255, 137, 171, 0.03); }
    .cmd-queue-item + .cmd-queue-item { border-top: 1px solid rgba(173, 170, 170, 0.06); }
    .cmd-queue-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.82rem; }
    .cmd-queue-title a { color: var(--on-surface-variant); }
    .cmd-queue-title a:hover { color: var(--on-surface); }

    /* Agent roster */
    .cmd-agent { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; padding: 0.66rem 1rem; transition: background 0.1s; }
    .cmd-agent:hover { background: rgba(0, 251, 251, 0.03); }
    .cmd-agent + .cmd-agent { border-top: 1px solid rgba(173, 170, 170, 0.06); }
    .cmd-agent-main { display: flex; align-items: center; gap: 0.6rem; min-width: 0; flex: 1; }
    .cmd-agent-dot { width: 6px; height: 6px; flex-shrink: 0; }
    .cmd-agent-dot-active { background: var(--secondary); box-shadow: 0 0 6px rgba(0, 251, 251, 0.4); animation: cmd-dot-pulse 2s ease-in-out infinite; }
    .cmd-agent-dot-idle { background: var(--muted); opacity: 0.4; }
    @keyframes cmd-dot-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .cmd-agent-name { display: block; min-width: 0; font-size: 0.84rem; font-weight: 600; color: var(--on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cmd-agent-name a { color: inherit; }
    .cmd-agent-name a:hover { color: var(--secondary); }

    /* Activity feed redesign */
    .cmd-feed-item { display: grid; grid-template-columns: auto 1fr auto; gap: 0.5rem; align-items: start; padding: 0.45rem 0.85rem; font-size: 0.78rem; }
    .cmd-feed-item + .cmd-feed-item { border-top: 1px solid rgba(173, 170, 170, 0.04); }
    .cmd-feed-agent { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 600; font-family: "Space Grotesk", sans-serif; color: var(--secondary); white-space: nowrap; font-size: 0.78rem; }
    .cmd-feed-agent a { color: inherit; }
    .cmd-feed-agent a:hover { color: var(--on-surface); }
    .cmd-feed-data { font-family: "JetBrains Mono", monospace; font-size: 0.72rem; color: var(--on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; line-height: 1.5; }
    .cmd-feed-time { font-family: "JetBrains Mono", monospace; font-size: 0.65rem; color: var(--muted); white-space: nowrap; }
    .cmd-feed-kind { font-family: "JetBrains Mono", monospace; font-size: 0.625rem; letter-spacing: 0.04em; text-transform: uppercase; border: 1px solid rgba(173, 170, 170, 0.25); color: var(--muted); padding: 0.1rem 0.35rem; }
    .cmd-feed-kind-message { border-color: rgba(0, 251, 251, 0.3); color: var(--secondary); }
    .cmd-feed-kind-tool, .cmd-feed-kind-other { border-color: rgba(173, 170, 170, 0.22); color: var(--muted); }
    .cmd-feed-item-tool .cmd-feed-agent, .cmd-feed-item-other .cmd-feed-agent { color: var(--muted); }
    .cmd-feed-item-tool .cmd-feed-data, .cmd-feed-item-other .cmd-feed-data { color: var(--muted); }
    .cmd-feed-filter-wrap { display: inline-flex; align-items: center; }
    .cmd-feed-filter { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.65rem; text-transform: lowercase; color: var(--muted); user-select: none; cursor: pointer; }
    .cmd-feed-filter input { accent-color: var(--secondary); transform: translateY(-0.5px); }
    body[data-activity-filter="messages"] #recent-activity .cmd-feed-item:not(.cmd-feed-item-message) { display: none; }

    /* Escalation alerts */
    .cmd-alert { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.55rem 0.85rem; background: rgba(255, 107, 107, 0.04); }
    .cmd-alert + .cmd-alert { border-top: 1px solid rgba(255, 107, 107, 0.08); }
    .cmd-alert-icon { color: var(--error); font-size: 0.85rem; flex-shrink: 0; line-height: 1.4; }
    .cmd-alert-body { flex: 1; min-width: 0; }
    .cmd-alert-text { font-size: 0.8rem; color: var(--on-surface-variant); line-height: 1.4; }
    .cmd-alert-meta { font-size: 0.7rem; color: var(--muted); margin-top: 0.15rem; }

    /* Delegation progress bars */
    .cmd-delegation { display: grid; gap: 0.36rem; padding: 0.64rem 1rem; }
    .cmd-delegation + .cmd-delegation { border-top: 1px solid rgba(173, 170, 170, 0.04); }
    .cmd-delegation-head { display: flex; align-items: baseline; gap: 0.55rem; flex-wrap: wrap; }
    .cmd-deleg-state {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.62rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .cmd-deleg-state-active { color: var(--secondary); }
    .cmd-deleg-state-done { color: rgba(173, 170, 170, 0.72); }
    .cmd-deleg-label { font-size: 0.76rem; color: var(--on-surface-variant); }
    .cmd-deleg-time { margin-left: auto; font-family: "JetBrains Mono", monospace; font-size: 0.62rem; color: var(--muted); }
    .cmd-deleg-bar { flex: 1; height: 3px; background: var(--surface-bright); position: relative; overflow: hidden; }
    .cmd-deleg-fill { height: 100%; background: var(--secondary); transition: width 0.3s ease; }
    .cmd-deleg-fill-failed { background: var(--error); }
    .cmd-deleg-label { font-family: "JetBrains Mono", monospace; font-size: 0.65rem; color: var(--muted); white-space: nowrap; }

    @media (max-width: 900px) {
      .navbar { flex-wrap: wrap; }
      .navbar-daemon-slot { margin-left: 0; width: 100%; justify-content: center; min-width: 0; }
      .docs-layout { grid-template-columns: 1fr; }
      .docs-index { position: static; max-height: none; }
      .cmd-layout { grid-template-columns: 1fr; gap: 0.85rem; }
      .cmd-dashboard-page-idle .cmd-layout { width: min(700px, calc(100vw - 1rem)); }
      .cmd-col { overflow: visible; }
      .cmd-layout-progress {
        flex: 0 0 auto;
        height: auto;
        min-height: 0;
        max-height: none;
      }
      .cmd-progress-grid { display: grid; height: auto; }
      .cmd-progress-columns { grid-template-columns: 1fr; }
      .cmd-layout-steer-active,
      .cmd-layout-steer-inactive {
        flex: 0 0 auto;
        height: auto;
        min-height: 0;
        max-height: none;
      }
      .cmd-progress-columns .cmd-progress-section + .cmd-progress-section { border-left: 0; border-top: 1px solid rgba(173, 170, 170, 0.08); }
      .cmd-phase-inline { align-items: flex-start; }
      .cmd-steer-toolbar { grid-template-columns: 1fr; }
      .cmd-steer-actions-row { width: 100%; justify-content: space-between; }
      .cmd-steer-actions-row .btn-sm { flex: 1; }
      .agent-card { flex-basis: calc((100% - 1.3rem) / 3); max-width: calc((100% - 1.3rem) / 3); }
      .team-layout { grid-template-columns: 1fr; }
      .team-create-layout { grid-template-columns: 1fr; }
      .task-create-layout { grid-template-columns: 1fr; }
      .task-instance-layout { grid-template-columns: 1fr; }
      .task-instance-hero-head { grid-template-columns: 1fr; }
      .task-instance-summary-grid { grid-template-columns: 1fr; }
      .phase-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .phase-card-list { grid-template-columns: 1fr; }
      .member-card-list { grid-template-columns: 1fr; }
      .member-grid { grid-template-columns: 1fr; }
      .logs-filter-form { align-items: stretch; }
      .logs-filter-field { min-width: 0; flex: 1 1 220px; }
      .logs-filter-actions { padding-bottom: 0; }
    }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
    @media (max-width: 560px) {
      .phase-grid { grid-template-columns: 1fr; }
      .navbar { padding: 0.65rem 0.85rem; gap: 0.8rem; }
      .container { padding: 0.8rem; }
      .page-header, .section-heading, .form-actions { flex-direction: column; align-items: stretch; }
      .task-form-grid { grid-template-columns: 1fr; }
      .cmd-inline-intake-controls { grid-template-columns: 1fr; }
      .cmd-inline-intake-submit { width: 100%; }
      .task-instance-summary-card { padding: 0.75rem; }
      .task-table th:nth-child(3), .task-table td:nth-child(3),
      .task-table th:nth-child(5), .task-table td:nth-child(5),
      .task-table th:nth-child(6), .task-table td:nth-child(6) { display: none; }
      .agent-card { flex-basis: calc((100% - 0.65rem) / 2); max-width: calc((100% - 0.65rem) / 2); }
      .logs-filter-card { padding: 0.75rem 0.75rem; }
      .logs-filter-actions { width: 100%; }
      .logs-filter-actions button { flex: 1 1 0; }
      .logs-feed-toolbar { padding: 0.65rem 0.75rem; }
      .logs-feed-meta { min-width: 0; }
    }

    /* ── Chat UI ─────────────────────────────────────────────── */

    /* Dashboard chat column */
    .cmd-col-chat {
      flex: 0 0 300px;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .cmd-layout-chat {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }

    /* Normal chat panel inner layout */
    #dashboard-chat-panel {
      display: flex;
      flex-direction: column;
    }

    /* Main chat area (everything except sidebar) */
    .chat-main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Conversation list sidebar (hidden by default, shown in fullscreen) */
    .chat-fullscreen-sidebar {
      display: none;
      width: 260px;
      flex-shrink: 0;
      flex-direction: column;
      border-right: 1px solid rgba(173, 170, 170, 0.1);
      overflow-y: auto;
      background: var(--surface-mid);
    }

    /* Fullscreen overlay */
    #dashboard-chat-panel.chat-fullscreen {
      position: fixed;
      inset: 0;
      top: 48px;
      z-index: 500;
      background: var(--surface-low);
      flex-direction: row;
      border: none;
    }
    /* Blurred backdrop behind the fullscreen chat. Body gets .chat-fullscreen-active
       when the chat opens; the ::after pseudo-element sits at z-index 499 (below the
       chat panel at 500) and blurs whatever is behind it. */
    body.chat-fullscreen-active::after {
      content: "";
      position: fixed;
      inset: 0;
      top: 48px;
      z-index: 499;
      background: rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      pointer-events: none;
    }
    #dashboard-chat-panel.chat-fullscreen .chat-fullscreen-sidebar {
      display: flex;
    }
    #dashboard-chat-panel.chat-fullscreen .chat-main {
      flex: 1;
      min-width: 0;
    }

    /* Messages area */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      overscroll-behavior: contain;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0.65rem 0.75rem;
      min-height: 0;
      background: var(--surface-low);
    }

    /* Individual message: container for one user/assistant turn. */
    .chat-message {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      font-size: 0.84rem;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .chat-message-user {
      align-self: flex-start;
      max-width: 100%;
      padding: 0.5rem 0.7rem;
      background: color-mix(in srgb, var(--accent-yellow) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent-yellow) 18%, transparent);
      border-radius: var(--sk-radius-sm);
    }
    .chat-message-user .chat-message-content {
      color: color-mix(in srgb, var(--on-surface-variant) 72%, #000);
      font-style: italic;
    }
    .chat-message-assistant {
      align-self: stretch;
      width: 100%;
      padding: 0;
      background: transparent;
      border: none;
    }
    .chat-message-system {
      align-self: center;
      max-width: 88%;
      padding: 0.5rem 0.7rem;
      background: color-mix(in srgb, var(--sk-accent-secondary) 5%, transparent);
      border: 1px solid color-mix(in srgb, var(--sk-accent-secondary) 14%, transparent);
      border-radius: var(--sk-radius-sm);
      font-size: 0.76rem;
      color: var(--muted);
    }
    .chat-message-content { color: var(--on-surface-variant); }

    /* Stream-part wrapper: each live block is appended in its own data-tagged div. */
    .chat-stream-part { display: contents; }

    /* Bubble — base shared appearance for any block emitted by the agent. */
    .chat-bubble {
      display: block;
      font-size: 0.84rem;
      line-height: 1.55;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    /* Text output: full-width, no bubble border so HTML content owns the space. */
    .chat-bubble-text {
      width: 100%;
      padding: 0.55rem 0.75rem;
      background: var(--surface-high);
      border: 1px solid rgba(173, 170, 170, 0.1);
      color: var(--on-surface-variant);
    }
    .chat-bubble-text > :first-child { margin-top: 0; }
    .chat-bubble-text > :last-child { margin-bottom: 0; }
    .chat-bubble-text h1,
    .chat-bubble-text h2,
    .chat-bubble-text h3 { margin: 0.6rem 0 0.3rem; line-height: 1.25; }
    .chat-bubble-text h1 { font-size: 1.1rem; }
    .chat-bubble-text h2 { font-size: 1.0rem; }
    .chat-bubble-text h3 { font-size: 0.92rem; }
    .chat-bubble-text p { margin: 0.35rem 0; }
    .chat-bubble-text ul,
    .chat-bubble-text ol { margin: 0.35rem 0 0.35rem 1.25rem; padding: 0; }
    .chat-bubble-text li { margin: 0.15rem 0; }
    .chat-bubble-text code {
      font-family: var(--sk-font-mono, monospace);
      font-size: 0.78rem;
      background: rgba(255, 255, 255, 0.04);
      padding: 0.05rem 0.3rem;
      border-radius: var(--sk-radius-xs);
    }
    .chat-bubble-text pre {
      background: var(--surface-low);
      border: 1px solid rgba(173, 170, 170, 0.08);
      padding: 0.5rem 0.65rem;
      overflow-x: auto;
      font-size: 0.78rem;
    }
    .chat-bubble-text pre code { background: transparent; padding: 0; }
    .chat-bubble-text table { border-collapse: collapse; width: 100%; margin: 0.45rem 0; font-size: 0.8rem; }
    .chat-bubble-text th,
    .chat-bubble-text td { border: 1px solid rgba(173, 170, 170, 0.15); padding: 0.3rem 0.5rem; text-align: left; }
    .chat-bubble-text blockquote {
      margin: 0.35rem 0;
      padding: 0.25rem 0.6rem;
      border-left: 2px solid rgba(0, 251, 251, 0.35);
      color: var(--muted);
    }

    /* Low-accent collapsed bubbles for thinking/tool blocks. */
    .chat-bubble-thinking,
    .chat-bubble-tool-use,
    .chat-bubble-tool-result {
      width: 100%;
      background: rgba(173, 170, 170, 0.04);
      border: 1px dashed rgba(173, 170, 170, 0.18);
      color: var(--muted);
      font-size: 0.74rem;
    }
    .chat-bubble-thinking > summary,
    .chat-bubble-tool-use > summary,
    .chat-bubble-tool-result > summary {
      cursor: pointer;
      list-style: none;
      padding: 0.3rem 0.6rem;
      font-family: var(--sk-font-mono, monospace);
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      color: var(--muted);
      user-select: none;
    }
    .chat-bubble-thinking > summary::-webkit-details-marker,
    .chat-bubble-tool-use > summary::-webkit-details-marker,
    .chat-bubble-tool-result > summary::-webkit-details-marker { display: none; }
    .chat-bubble-thinking > summary::before,
    .chat-bubble-tool-use > summary::before,
    .chat-bubble-tool-result > summary::before {
      content: "\\25B8";
      display: inline-block;
      width: 0.9rem;
      transition: transform 0.12s ease;
      color: var(--muted);
    }
    .chat-bubble-thinking[open] > summary::before,
    .chat-bubble-tool-use[open] > summary::before,
    .chat-bubble-tool-result[open] > summary::before {
      transform: rotate(90deg);
    }
    .chat-bubble-body {
      padding: 0.25rem 0.7rem 0.5rem;
      color: var(--on-surface-variant);
      font-size: 0.78rem;
      line-height: 1.5;
    }
    .chat-bubble-pre {
      margin: 0.25rem 0.5rem 0.5rem;
      padding: 0.45rem 0.6rem;
      background: var(--surface-low);
      border: 1px solid rgba(173, 170, 170, 0.08);
      font-family: var(--sk-font-mono, monospace);
      font-size: 0.74rem;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }
    .chat-bubble-tool-use { border-color: rgba(0, 251, 251, 0.18); }
    .chat-bubble-tool-result { border-color: rgba(132, 226, 132, 0.18); }

    /* User-toggleable filter: when the messages container has .hide-tool-calls,
       all tool_use, tool_result and thinking bubbles are removed from layout.
       Thinking blocks are model deliberation, not user-facing output, so they
       follow the same visibility rule as raw tool I/O. */
    .chat-messages.hide-tool-calls .chat-bubble-tool-use,
    .chat-messages.hide-tool-calls .chat-bubble-tool-result,
    .chat-messages.hide-tool-calls .chat-bubble-thinking {
      display: none;
    }

    /* Header checkbox control for the filter. */
    .chat-filter-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.7rem;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
    }
    .chat-filter-toggle input {
      accent-color: var(--secondary, #00fbfb);
      margin: 0;
      cursor: pointer;
    }
    .chat-filter-toggle:hover { color: var(--on-surface-variant); }

    /* Input area */
    .chat-input-area {
      flex-shrink: 0;
      padding: 0.55rem 0.65rem;
      border-top: 1px solid rgba(173, 170, 170, 0.08);
      background: var(--surface-mid);
    }
    .chat-input-area form {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }
    .chat-input-area textarea {
      width: 100%;
      padding: 0.42rem 0.52rem;
      border: 1px solid var(--sk-border-subtle);
      background: color-mix(in srgb, var(--sk-surface-0) 28%, transparent);
      color: var(--on-surface);
      font-size: 0.82rem;
      font-family: "Inter", sans-serif;
      resize: vertical;
      outline: none;
      transition: border-color 0.12s;
      border-radius: var(--sk-radius-sm);
      margin: 0;
    }
    .chat-input-area textarea:focus {
      border-color: rgba(0, 251, 251, 0.45);
    }
    .chat-input-row {
      display: flex;
      gap: 0.35rem;
      justify-content: flex-end;
      align-items: center;
    }

    /* Slash-command autocomplete dropdown */
    .sk-slash-menu {
      position: absolute;
      left: 0.55rem;
      right: 0.55rem;
      bottom: calc(100% - 0.35rem);
      max-height: 240px;
      overflow-y: auto;
      background: var(--surface-high, #161616);
      border: 1px solid var(--sk-border-active);
      border-radius: var(--sk-radius-sm);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
      z-index: 50;
      font-family: "Inter", sans-serif;
    }
    .sk-slash-menu__item {
      padding: 0.4rem 0.55rem;
      cursor: pointer;
      border-bottom: 1px solid var(--sk-border);
    }
    .sk-slash-menu__item:last-child {
      border-bottom: none;
    }
    .sk-slash-menu__item.is-active,
    .sk-slash-menu__item:hover {
      background: color-mix(in srgb, var(--sk-accent-secondary) 12%, transparent);
    }
    .sk-slash-menu__name {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--on-surface);
    }
    .sk-slash-menu__desc {
      font-size: 0.7rem;
      color: var(--on-surface-variant);
      margin-top: 0.12rem;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .sk-slash-menu__empty {
      padding: 0.5rem 0.55rem;
      font-size: 0.75rem;
      color: var(--sk-text-subtle);
    }

    /* Empty state */
    .chat-empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.7rem;
      padding: 1.5rem;
      text-align: center;
    }

    /* Conversation sidebar list */
    .conversation-list {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
      flex: 1;
    }
    .conversation-item {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.5rem 0.75rem;
      font-size: 0.82rem;
      color: var(--on-surface-variant);
      cursor: pointer;
      transition: background 0.1s;
      border-bottom: 1px solid rgba(173, 170, 170, 0.05);
    }
    .conversation-item:hover { background: rgba(255, 137, 171, 0.04); }
    .conversation-item.active {
      background: rgba(0, 251, 251, 0.06);
      color: var(--on-surface);
    }
    .conv-item-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .conv-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .conv-status-active { background: var(--tertiary); box-shadow: 0 0 4px rgba(176, 255, 150, 0.5); }
    .conv-status-archived { background: var(--muted); opacity: 0.45; }

    @media (max-width: 900px) {
      .cmd-col-chat { flex: 0 0 260px; }
    }
    @media (max-width: 768px) {
      .cmd-col-chat { flex: 0 0 auto; width: 100%; }
      #dashboard-chat-panel.chat-fullscreen { top: 0; }

      /* Generic mobile hide utility — apply to elements we want suppressed on
       * narrow viewports without restructuring HTML. */
      .mc-mobile-hide { display: none !important; }

      /* Modal: trim padding so dialogs claim more usable width. */
      .sk-modal { padding: 0.25rem !important; }
      .sk-modal__content {
        width: 100vw !important;
        max-width: none !important;
        max-height: 100vh !important;
        border-radius: 0 !important;
      }
      .artifact-modal { padding: 0; }
      .artifact-modal-dialog {
        width: 100vw !important;
        height: 100vh !important;
        border-radius: 0 !important;
      }

      /* Card grids: stack at one column instead of relying on fixed minmax that
       * forces horizontal overflow on phones. */
      .dashboard-grid,
      .stats-row,
      .metrics-grid {
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)) !important;
      }
    }
  `;
}
