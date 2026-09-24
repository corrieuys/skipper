/**
 * Glyph overlay (experimental): the full-screen modal + the node styles the
 * browser renderer (public/glyph.js) targets. Port of glyph-ui's style.css onto
 * Skipper's tokens; the protocol carries no style, all of it lives here.
 *
 * Theme contract: every colour, radius and font is a `--sk-*` token, and card
 * containers carry `.sk-panel` (added by glyph.js), so a theme's panel rules
 * (Artemis glass blur, Win95 chrome, GeoCities borders) restyle the screen with
 * no glyph-specific work. Nothing here is a literal colour.
 *
 * Class names are `gl-n-<type>` per node type, `gl-em` emphasis, `gl-ctr` center.
 */
export function glyphStyles(): string {
  return `
    /* ── Glyph overlay shell ── */
    .tc-glyph.sk-modal { padding: 0; background: var(--sk-surface-0); }
    .tc-glyph__content.sk-modal__content {
      width: 100vw;
      max-width: none;
      height: 100vh;
      max-height: none;
      border: 0;
      border-radius: 0;
      background: transparent;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--sk-font-body);
      color: var(--sk-text);
    }
    .tc-glyph__bar {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      padding: var(--sk-space-2) var(--sk-space-4);
      border-bottom: 1px solid var(--sk-border);
      background: var(--sk-panel-bg);
      flex: 0 0 auto;
      font-size: var(--sk-text-sm);
    }
    .tc-glyph__title { font-family: var(--sk-font-heading); font-weight: 600; color: var(--sk-text); }
    .tc-glyph__brand { display: inline-flex; align-items: center; gap: 0.5rem; font-family: var(--sk-font-heading); font-weight: 600; color: var(--sk-text); text-transform: lowercase; }
    .tc-glyph__brand img { height: 22px; width: auto; }
    /* composer in the bar: the same input verb as the task view, so the operator can steer with the canvas open */
    .tc-glyph__composer { display: flex; align-items: center; gap: var(--sk-space-2); flex: 1 1 auto; min-width: 0; max-width: 640px; margin-left: var(--sk-space-4); }
    .tc-glyph__composer .sk-btn { flex: 0 0 auto; width: 4rem; justify-content: center; }
    .tc-glyph__brand { flex: 0 0 auto; }
    .tc-glyph__hint { flex: 0 0 auto; }
    .tc-glyph__input { flex: 1 1 auto; min-width: 0; padding: 0.35rem 0.6rem; border-radius: var(--sk-radius-md); border: 1px solid var(--sk-border-subtle); background: var(--sk-surface-2); color: var(--sk-text); font: inherit; font-size: var(--sk-text-sm); }
    .tc-glyph__input:focus { outline: 0; border-color: var(--sk-accent-primary); }
    /* Every slot in the bar has a fixed size. Text that changes (Live/Rendering,
       Acquiring/Recording) never moves its neighbours: it lives in a
       fixed-width box and is clipped, and the state colour is a dot. */
    .tc-glyph__audio { display: inline-flex; align-items: center; gap: var(--sk-space-2); flex: 0 0 auto; }
    .tc-glyph__audio .sk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; width: 5.75rem; flex: 0 0 auto; }
    .tc-glyph__audio [data-rt-status] { display: inline-block; width: 7.5rem; flex: 0 0 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tc-glyph__spacer--fill { flex: 1 1 auto; }
    @media (max-width: 900px) { .tc-glyph__hint { display: none; } .tc-glyph__composer { margin-left: var(--sk-space-2); } }
    .tc-glyph__status {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      width: 6.5rem;
      flex: 0 0 auto;
      color: var(--sk-text-muted);
      font-size: var(--sk-text-xs);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tc-glyph__status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--sk-text-subtle);
      transition: background 200ms ease;
    }
    .tc-glyph__status--busy::before { background: var(--sk-accent-secondary); animation: gl-breathe 1.6s ease-in-out infinite; }
    .tc-glyph__status--error::before { background: var(--sk-accent-warning); }
    .tc-glyph__status--busy, .tc-glyph__status--error { color: var(--sk-text-muted); }
    .tc-glyph__spacer { flex: 1 1 auto; }
    .tc-glyph__hint { color: var(--sk-text-subtle); font-size: var(--sk-text-xs); }
    .tc-glyph__stage-wrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
    .tc-glyph__stage {
      position: relative;
      display: flex;
      flex: 1 1 auto;
      padding: var(--sk-space-4);
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      color: var(--sk-text);
      font-family: var(--sk-font-body);
      font-size: var(--sk-text-lg);
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    .tc-glyph__empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      pointer-events: none;
      color: var(--sk-text-muted);
    }
    .tc-glyph__empty[hidden] { display: none; }
    .tc-glyph__empty-title {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-2xl);
      font-weight: 600;
      letter-spacing: -0.02em;
      animation: gl-breathe 3.2s ease-in-out infinite;
    }
    .tc-glyph__empty-sub {
      font-family: var(--sk-font-mono);
      font-size: var(--sk-text-xs);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--sk-text-subtle);
    }
    @keyframes gl-breathe {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.03); }
    }
    .tc-glyph__ghosts { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
    .tc-glyph__ghosts > .gl-n { position: absolute; margin: 0; }

    /* ── Nodes ── */
    .tc-glyph {
      --gl-gap: var(--sk-space-3);
      --gl-pad: var(--sk-space-3);
      --gl-leaf-bg: var(--sk-surface-2);
      --gl-leaf-radius: var(--sk-radius-md);
    }
    .gl-n {
      position: relative;
      flex: 0 1 auto;
      min-width: 0;
      min-height: 0;
      transform-origin: 0 0;
      will-change: transform;
      box-sizing: border-box;
    }
    /* Containers. Below the root they are .sk-panel cards (class set by glyph.js),
       so the base panel background/border and any theme's panel rules apply. */
    .gl-n-r, .gl-n-c, .gl-n-s {
      display: flex;
      gap: var(--gl-gap);
      padding: var(--gl-pad);
      border-radius: var(--sk-panel-radius);
    }
    .gl-n-r.sk-panel, .gl-n-c.sk-panel, .gl-n-s.sk-panel { background: var(--sk-panel-bg); border: 1px solid var(--sk-border); }
    :is(.gl-n-r, .gl-n-c, .gl-n-s).sk-panel:is([data-depth="2"], [data-depth="4"], [data-depth="6"]) { background: var(--sk-panel-elevated-bg); }
    .gl-n-r, .gl-n-c, .gl-n-s, .gl-n-b { flex-basis: 0; }
    .gl-n-l, .gl-n-T, .gl-n-k, .gl-n-h { flex-shrink: 1; }
    .gl-n-c > :is(.gl-n-t, .gl-n-h, .gl-n-l, .gl-n-T, .gl-n-k) { flex-shrink: 0; }
    .gl-n-t { flex-shrink: 1; white-space: pre-line; overflow-wrap: anywhere; }
    .gl-n-r { flex-direction: row; }
    /* no container ever scrolls: the stage zooms to fit instead (glyph.js fitToStage) */
    .gl-n-c { flex-direction: column; overflow: hidden; }
    .gl-n-r, .gl-n-s { overflow: hidden; }
    .gl-n-s { display: grid; grid-template-areas: "z"; }
    .gl-n-s > .gl-n { grid-area: z; }
    .gl-n-r.gl-ctr, .gl-n-c.gl-ctr { justify-content: center; align-items: center; }
    .gl-n-s.gl-ctr { place-items: center; }
    :is(.gl-n-r, .gl-n-c, .gl-n-s)[data-depth="0"] { background: transparent; border: 0; padding: 0; }

    .gl-n-b {
      min-height: 56px;
      border-radius: var(--gl-leaf-radius);
      background:
        radial-gradient(120% 90% at 30% 20%, var(--sk-accent-primary-dim), transparent 60%),
        var(--gl-leaf-bg);
      border: 1px solid var(--sk-border);
    }
    /* web view: an image or a page the agents produced. Fills its slot. */
    .gl-n-w {
      display: block;
      flex-basis: 0;
      min-height: 180px;
      width: auto;
      height: auto;
      border: 1px solid var(--sk-border);
      border-radius: var(--gl-leaf-radius);
      background: var(--gl-leaf-bg);
    }
    iframe.gl-n-w { width: 100%; }
    img.gl-n-w { object-fit: contain; object-position: center; max-width: 100%; align-self: stretch; }
    .gl-n-w::after { display: none; }

    .gl-n-h {
      padding: var(--sk-space-2) var(--sk-space-3);
      font-family: var(--sk-font-heading);
      font-weight: 600;
      font-size: var(--sk-text-xl);
      letter-spacing: -0.01em;
      color: var(--sk-text);
      overflow-wrap: anywhere;
    }
    .gl-n-c > .gl-n-h + .gl-n-t { color: var(--sk-text-muted); background: transparent; border-color: transparent; margin-top: calc(-1 * var(--gl-gap) + 2px); }
    .gl-n-l {
      margin: 0;
      padding: var(--sk-space-2) var(--sk-space-3) var(--sk-space-2) calc(var(--sk-space-3) + 1rem);
      border-radius: var(--gl-leaf-radius);
      background: var(--gl-leaf-bg);
      border: 1px solid var(--sk-border);
      overflow-wrap: anywhere;
    }
    .gl-n-l li { padding: 2px 0; }
    .gl-n-l li::marker { color: var(--sk-accent-primary); }
    .gl-n-T {
      border-radius: var(--gl-leaf-radius);
      background: var(--gl-leaf-bg);
      border: 1px solid var(--sk-border);
      overflow-x: auto;
      align-self: stretch;
      font-variant-numeric: tabular-nums;
      font-size: var(--sk-text-base);
    }
    .gl-n-T table { border-collapse: collapse; width: 100%; }
    .gl-n-T th, .gl-n-T td { padding: var(--sk-space-2) var(--sk-space-3); text-align: left; vertical-align: top; overflow-wrap: break-word; }
    .gl-n-T th { font-weight: 600; color: var(--sk-text-muted); font-size: var(--sk-text-xs); letter-spacing: 0.02em; text-transform: uppercase; white-space: nowrap; border-bottom: 1px solid var(--sk-border); }
    .gl-n-T tbody tr + tr td { border-top: 1px solid var(--sk-border); }
    .gl-n-T td:first-child { font-weight: 500; }
    .gl-n-k {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px var(--sk-space-4);
      margin: 0;
      padding: var(--sk-space-2) var(--sk-space-3);
      border-radius: var(--gl-leaf-radius);
      background: var(--gl-leaf-bg);
      border: 1px solid var(--sk-border);
    }
    .gl-n-k dt { color: var(--sk-text-muted); }
    .gl-n-k dd { margin: 0; overflow-wrap: anywhere; }
    .gl-n-c > .gl-n-t:first-child {
      background: transparent;
      border-color: transparent;
      font-family: var(--sk-font-heading);
      font-weight: 600;
      font-size: var(--sk-text-xl);
      letter-spacing: -0.01em;
    }
    .gl-n-c > .gl-n-t:first-child + .gl-n-t { color: var(--sk-text-muted); background: transparent; border-color: transparent; }
    .gl-n-t {
      padding: var(--sk-space-2) var(--sk-space-3);
      border-radius: var(--gl-leaf-radius);
      background: var(--gl-leaf-bg);
      border: 1px solid var(--sk-border);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .gl-n-r > .gl-n-t { align-self: center; }

    /* emphasis: the theme's primary accent as a breathing ring + glow, plus a slow sheen on containers */
    .gl-em {
      --gl-em-ring: var(--sk-accent-primary);
      --gl-em-glow: var(--sk-accent-primary-dim);
      border-color: var(--gl-em-ring);
      box-shadow: 0 0 0 1px var(--gl-em-ring), var(--sk-glow-primary);
      animation: gl-em-breathe 2.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
    }
    .gl-em::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background: linear-gradient(115deg, transparent 30%, var(--sk-accent-primary-dim) 50%, transparent 70%);
      background-size: 250% 100%;
      opacity: 0.5;
      animation: gl-em-sheen 4.2s ease-in-out infinite;
    }
    @keyframes gl-em-breathe {
      0%, 100% { box-shadow: 0 0 0 1px var(--gl-em-ring), 0 0 0 4px transparent, var(--sk-glow-primary); }
      50% { box-shadow: 0 0 0 1.5px var(--gl-em-ring), 0 0 0 6px var(--gl-em-glow), var(--sk-glow-primary); }
    }
    @keyframes gl-em-sheen {
      0% { background-position: 120% 0; }
      100% { background-position: -30% 0; }
    }
    @media (prefers-reduced-motion: reduce) { .gl-em, .gl-em::before, .tc-glyph__empty-title { animation: none; } }

    /* fresh: what changed in the last update. Border only: the element's own
       border takes a dim tint of the secondary accent and fades back to its
       normal colour in about a second. No outline, no wash, no pseudo-element,
       so it sits exactly on the element's box. The missing 100% keyframe means
       the animation ends at each element's own border colour, whatever the
       theme set. Kept deliberately faint and short so a redraw reads as a hint,
       not a flash. Distinct from the primary-accent emphasis ring. */
    .gl-fresh { animation: gl-fresh 1.1s ease-out; }
    @keyframes gl-fresh {
      0%, 15% { border-color: var(--sk-accent-secondary-dim); }
    }
    /* headings carry no visible border; give them a transparent one so the
       highlight has something to colour without changing their layout */
    .gl-n-h { border: 1px solid transparent; }
    @media (prefers-reduced-motion: reduce) { .gl-fresh { animation-duration: 0.5s; } }

    /* id chips (press i inside the overlay) */
    .gl-n::after {
      content: attr(data-id);
      position: absolute;
      top: 6px;
      right: 8px;
      font: 500 10px/1 var(--sk-font-mono);
      color: var(--sk-text-subtle);
      pointer-events: none;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .tc-glyph--ids .gl-n::after { opacity: 1; }
  `;
}
