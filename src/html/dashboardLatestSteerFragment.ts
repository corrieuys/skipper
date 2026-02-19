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

export function dashboardSteerListFragment(options: SteeringOption[]): string {
  const steerable = options.filter((o) => o.can_steer);
  if (steerable.length === 0) {
    return `<div class="cmd-latest-steer cmd-latest-steer--empty" style="padding:0.6rem 0.85rem;color:var(--muted);font-size:0.78rem;">No steerable agent</div>`;
  }
  const cards = steerable.map(steerCardMarkup).join("");
  return `<div class="mc-steer-stack">${cards}</div>`;
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

  return `<div class="mc-steer-card">
    <div id="mc-steer-info-${eid}" class="mc-steer-card__info">
      <div class="mc-steer-card__header">
        <span class="cmd-agent-dot cmd-agent-dot-active mc-steer-card__dot" title="Active"></span>
        <a class="mc-steer-card__name" href="/agents/${tid}" hx-get="/agents/${tid}" hx-target="body" hx-push-url="true">${escapeHtml(opt.agent_name)}</a>
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
