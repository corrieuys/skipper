import { escapeHtml } from "./atoms/escape-html";
import { thinkingWaveHtml } from "./atoms/thinking-wave";

export interface SteeringOption {
  template_agent_id: string;
  agent_name: string;
  runtime_id: string;
  task_id: string;
  task_title: string | null;
  session_id: string | null;
  process_pid: number | null;
  can_steer: boolean;
  disabled_reason: string | null;
  /** Latest assistant message text (not a tool call) from this runtime's terminal output. */
  latest_message?: string | null;
}

/** One orb in the dashboard team roster (mirrors zen mode's team orbs). */
export interface AgentTile {
  template_agent_id: string;
  agent_name: string;
  /** Has ≥1 running/waiting instance for the current context. */
  is_active: boolean;
  /** Number of active instances (drives the count badge). */
  instance_count: number;
}

/**
 * Collapse live steer options into tiles grouped by agent type. Used for the
 * aggregate dashboard (no single team), where only running agents are known.
 */
export function groupSteerOptionsToTiles(options: SteeringOption[]): AgentTile[] {
  const steerable = options.filter((o) => o.can_steer);
  const groups = new Map<string, AgentTile>();
  for (const o of steerable) {
    const tile = groups.get(o.template_agent_id);
    if (tile) tile.instance_count++;
    else groups.set(o.template_agent_id, {
      template_agent_id: o.template_agent_id,
      agent_name: o.agent_name,
      is_active: true,
      instance_count: 1,
    });
  }
  return [...groups.values()];
}

/**
 * Zen-style team roster for the dashboard. Renders every team member using the
 * same `.zen-orb` markup as zen mode, so `zen-orbs-3d.js` upgrades them to the
 * faceted 3D gems (active = lit, idle = dimmed). Orbs are flagged
 * `data-zen-no-drag` so the 3D drag handler is suppressed and a click opens the
 * instance modal (see `agentInstancesModalFragment`) where steering happens.
 * Idle members render as non-interactive orbs.
 */
export function dashboardSteerListFragment(tiles: AgentTile[], taskId?: string | null): string {
  if (tiles.length === 0) {
    return `<div class="cmd-latest-steer cmd-latest-steer--empty" style="padding:0.6rem 0.85rem;color:var(--muted);font-size:0.78rem;">No team members</div>`;
  }

  const taskAttr = taskId ? ` data-task-id="${escapeHtml(taskId)}"` : "";
  const items = tiles.map((t) => {
    const tid = escapeHtml(t.template_agent_id);
    const name = escapeHtml(t.agent_name);
    const stateCls = t.is_active ? "zen-orb--active" : "zen-orb--inactive";

    if (!t.is_active) {
      return `<div class="zen-view__orb-wrapper mc-agent-orb-wrapper">
        <div class="zen-orb ${stateCls}" data-zen-agent="${name}" data-zen-no-drag="1" title="${name} (idle)">
          <div class="zen-orb__shine"></div>
        </div>
        <span class="zen-view__orb-label">${name}</span>
      </div>`;
    }

    const countBadge = t.instance_count > 1
      ? `<span class="mc-agent-orb__count" title="${t.instance_count} active instances">${t.instance_count}</span>`
      : "";
    return `<div class="zen-view__orb-wrapper mc-agent-orb-wrapper">
      ${countBadge}
      <div class="zen-orb ${stateCls} mc-agent-orb--clickable" data-zen-agent="${name}" data-zen-no-drag="1"
           data-mc-agent-tile data-template-id="${tid}" data-agent-name="${name}"${taskAttr}
           role="button" tabindex="0" title="Steer ${name}">
        <div class="zen-orb__shine"></div>
      </div>
      <span class="zen-view__orb-label">${name}</span>
    </div>`;
  }).join("");

  return `<div class="zen-view__orbs mc-agent-orbs">${items}</div>`;
}

/**
 * Instance list shown inside the agent modal: one steer card per running
 * instance (latest output + steer input), scrollable when there are many.
 */
export function agentInstancesModalFragment(options: SteeringOption[]): string {
  const steerable = options.filter((o) => o.can_steer);
  if (steerable.length === 0) {
    // Sentinel: the open modal's poller closes when it sees this.
    return `<div class="sk-muted" data-mc-agent-empty="1" style="padding:0.75rem;">No active instances</div>`;
  }
  return `<div class="mc-agent-instances">${steerable.map(steerCardMarkup).join("")}</div>`;
}

export function steerCardInfoMarkup(opt: SteeringOption): string {
  const eid = escapeHtml(opt.runtime_id);
  const tid = escapeHtml(opt.template_agent_id);
  const pidBadge = typeof opt.process_pid === "number"
    ? `<span class="mc-steer-card__pid" title="Process ID">PID ${opt.process_pid}</span>`
    : "";
  const messageSnippet = (opt.latest_message ?? "").trim();
  const wave = thinkingWaveHtml(messageSnippet);
  const messageHtml = messageSnippet
    ? `<span class="mc-steer-card__sep">|</span><span class="mc-steer-card__message" title="${escapeHtml(messageSnippet)}">${wave ?? escapeHtml(messageSnippet)}</span>`
    : `<span class="mc-steer-card__sep">|</span><span class="mc-steer-card__message mc-steer-card__message--empty">No output yet</span>`;

  return `<div id="mc-steer-info-${eid}" class="mc-steer-card__info">
      <div class="mc-steer-card__header">
        <span class="cmd-agent-dot cmd-agent-dot-active mc-steer-card__dot" title="Active"></span>
        <a class="mc-steer-card__name" href="/agents/${tid}" hx-get="/agents/${tid}" hx-target="body" hx-push-url="true">${escapeHtml(opt.agent_name)}</a>
        ${opt.task_title ? `<span class="mc-steer-card__task" title="Task">${escapeHtml(opt.task_title)}</span>` : ""}
        ${pidBadge}
        ${messageHtml}
      </div>
    </div>`;
}

function steerCardMarkup(opt: SteeringOption): string {
  const eid = escapeHtml(opt.runtime_id);
  const tid = escapeHtml(opt.template_agent_id);
  const pidBadge = typeof opt.process_pid === "number"
    ? `<span class="mc-steer-card__pid" title="Process ID">PID ${opt.process_pid}</span>`
    : "";
  const messageSnippet = (opt.latest_message ?? "").trim();
  const wave = thinkingWaveHtml(messageSnippet);
  const messageHtml = messageSnippet
    ? `<span class="mc-steer-card__sep">|</span><span class="mc-steer-card__message" title="${escapeHtml(messageSnippet)}">${wave ?? escapeHtml(messageSnippet)}</span>`
    : `<span class="mc-steer-card__sep">|</span><span class="mc-steer-card__message mc-steer-card__message--empty">No output yet</span>`;

  return `<div class="mc-steer-card" data-runtime-id="${eid}">
    <div id="mc-steer-info-${eid}" class="mc-steer-card__info">
      <div class="mc-steer-card__header">
        <span class="cmd-agent-dot cmd-agent-dot-active mc-steer-card__dot" title="Active"></span>
        <a class="mc-steer-card__name" href="/agents/${tid}" hx-get="/agents/${tid}" hx-target="body" hx-push-url="true">${escapeHtml(opt.agent_name)}</a>
        ${opt.task_title ? `<span class="mc-steer-card__task" title="Task">${escapeHtml(opt.task_title)}</span>` : ""}
        ${pidBadge}
        ${messageHtml}
      </div>
    </div>
    <form class="mc-steer-card__footer" hx-post="/api/dashboard/steer" hx-swap="none"
      hx-on::after-request="if(event.detail.successful){var t=document.getElementById('steer-textarea-${eid}');if(t){t.value='';}}">
      <input type="hidden" name="template_agent_id" value="${tid}">
      <input type="hidden" name="runtime_id" value="${eid}">
      <textarea id="steer-textarea-${eid}" name="message" rows="1" required placeholder="Steer this agent..." class="mc-steer-card__input"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();this.form.requestSubmit();}"></textarea>
      <button type="submit" class="sk-btn sk-btn--primary sk-btn--sm mc-steer-card__btn">Steer</button>
    </form>
  </div>`;
}
