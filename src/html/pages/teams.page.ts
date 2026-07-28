import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import type { LocalTeam } from "../../teams/local-teams";

export interface TeamsPageViewModel {
  teams: LocalTeam[];
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

/**
 * Miniature of the team's phase flow: phase name pills joined by arrows, with a
 * diamond marking a review gate. Gives the card the same reading order as the
 * full map on /teams/:id.
 */
function miniFlow(team: LocalTeam): string {
  if (team.phases.length === 0) {
    return `<div class="tm-mini"><span class="sk-text-xs sk-muted">No phases yet</span></div>`;
  }
  const shown = team.phases.slice(0, 4);
  const parts: string[] = [];
  shown.forEach((p, i) => {
    parts.push(`<span class="tm-mini__node">${escapeHtml(p.name)}</span>`);
    const isLastShown = i === shown.length - 1;
    if (p.review) parts.push(`<span class="tm-mini__gate" title="Review gate">&#9670;</span>`);
    if (!isLastShown) parts.push(`<span class="tm-mini__arrow">&rarr;</span>`);
  });
  if (team.phases.length > shown.length) {
    parts.push(`<span class="tm-mini__arrow">&rarr;</span>`);
    parts.push(`<span class="tm-mini__node">+${team.phases.length - shown.length} more</span>`);
  }
  return `<div class="tm-mini">${parts.join("")}</div>`;
}

function teamCard(team: LocalTeam): string {
  const gates = team.phases.filter((p) => p.review).length;
  const slack = team.config?.slackEnabled
    ? `<span class="tm-chip tm-chip--slack">Slack</span>`
    : "";
  const slash = team.config?.slashCommand
    ? `<span class="tm-chip">${escapeHtml(team.config.slashCommand)}</span>`
    : "";
  return `<div class="tm-card">
    <a class="tm-card__link" href="/teams/${escapeHtml(team.id)}">
      <div class="tm-card__name">${escapeHtml(team.name)}</div>
      <div class="tm-card__meta">
        <span>${team.phases.length} phase${team.phases.length === 1 ? "" : "s"}</span>
        <span>&middot;</span>
        <span>${team.agents.length} agent${team.agents.length === 1 ? "" : "s"}</span>
        ${gates > 0 ? `<span>&middot;</span><span>${gates} gate${gates === 1 ? "" : "s"}</span>` : ""}
      </div>
      ${miniFlow(team)}
    </a>
    ${slack || slash ? `<div class="tm-phase__chips">${slack}${slash}</div>` : ""}
    <div class="tm-card__actions">
      <a class="sk-btn sk-btn--sm" href="/teams/${escapeHtml(team.id)}">Open</a>
      <a class="sk-btn sk-btn--sm" href="/api/teams/export?id=${encodeURIComponent(team.id)}">Export</a>
      <button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-tm-delete="${escapeHtml(team.id)}"
        data-tm-name="${escapeHtml(team.name)}">Delete</button>
    </div>
  </div>`;
}

export function teamsPage(vm: TeamsPageViewModel): string {
  const cards = vm.teams.map(teamCard).join("");

  const body = vm.teams.length === 0
    ? `<div class="tm-empty">
         <p>No teams yet.</p>
         <a class="sk-btn sk-btn--primary" href="/teams/new">Create your first team</a>
       </div>`
    : `<div class="tm-grid">
         ${cards}
         <a class="tm-card tm-card--new" href="/teams/new">+ New team</a>
       </div>`;

  return v2layout("Teams", `
    ${navbar({ currentPath: "/teams", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div class="tm-shell">
      <div class="tm-topbar">
        <div class="tm-topbar__heading">
          <h1 class="tm-topbar__title">Teams</h1>
          <div class="tm-topbar__sub">Each team is a phase flow plus the crew that runs it. Skipper leads every team.</div>
        </div>
        <div class="tm-topbar__actions">
          <button type="button" class="sk-btn sk-btn--sm" id="tm-import-toggle">Import</button>
          <a class="sk-btn sk-btn--sm" href="/api/teams/export">Export all</a>
          <a class="sk-btn sk-btn--sm sk-btn--primary" href="/teams/new">New team</a>
        </div>
      </div>

      <div class="tm-sub" id="tm-import" hidden>
        <div class="tm-sub__head">
          <strong class="sk-text-sm">Import teams</strong>
          <span class="sk-text-xs sk-muted">Existing ids are updated, new ids created.</span>
        </div>
        <textarea id="tm-import-json" class="sk-textarea" rows="5" placeholder='{"teams":[ ... ]}'></textarea>
        <div style="display:flex;gap:var(--sk-space-2);align-items:center;margin-top:var(--sk-space-2);flex-wrap:wrap;">
          <input type="file" id="tm-import-file" accept="application/json,.json" class="sk-input" style="max-width:280px;">
          <button type="button" class="sk-btn sk-btn--sm sk-btn--primary" id="tm-import-btn">Import</button>
          <span id="tm-import-result" class="sk-text-xs sk-muted"></span>
        </div>
      </div>

      ${body}
    </div>

    <script>
    (function(){
      var toggle = document.getElementById('tm-import-toggle');
      var panel = document.getElementById('tm-import');
      toggle.addEventListener('click', function(){ panel.hidden = !panel.hidden; });

      var fileInput = document.getElementById('tm-import-file');
      var textArea = document.getElementById('tm-import-json');
      var result = document.getElementById('tm-import-result');
      fileInput.addEventListener('change', function(){
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function(){ textArea.value = String(reader.result || ''); };
        reader.readAsText(f);
      });

      document.getElementById('tm-import-btn').addEventListener('click', async function(){
        result.textContent = 'Importing...';
        var parsed;
        try { parsed = JSON.parse(textArea.value); }
        catch (e) { result.textContent = 'Invalid JSON.'; return; }
        try {
          var res = await fetch('/api/teams/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
          });
          var data = await res.json();
          if (!res.ok) { result.textContent = data.error || 'Import failed.'; return; }
          var msg = 'Imported ' + data.imported + ', updated ' + data.updated + '.';
          if (data.errors && data.errors.length) {
            msg += ' Errors: ' + data.errors.map(function(e){ return e.team + ': ' + e.error; }).join('; ');
          }
          result.textContent = msg;
          setTimeout(function(){ window.location.reload(); }, 800);
        } catch (e) {
          result.textContent = 'Import failed.';
        }
      });

      document.querySelectorAll('[data-tm-delete]').forEach(function(btn){
        btn.addEventListener('click', async function(){
          var id = btn.getAttribute('data-tm-delete');
          var name = btn.getAttribute('data-tm-name');
          if (!window.confirm('Delete team "' + name + '"? This cannot be undone.')) return;
          var res = await fetch('/api/teams/' + encodeURIComponent(id), { method: 'DELETE' });
          if (res.ok) window.location.reload();
        });
      });
    })();
    </script>
  `, "/teams");
}
