import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";
import { escapeHtml } from "../atoms/escape-html";
import type { LocalTeam } from "../../teams/local-teams";
import type { RemoteTeamRepo } from "../../teams/remote-repos";

export interface TeamsPageViewModel {
  teams: LocalTeam[];
  /** Linked remote team repos. `null` hides the Remote teams section (not experimental). */
  remoteRepos: RemoteTeamRepo[] | null;
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

function teamCard(team: LocalTeam, opts: { canDuplicate?: boolean } = {}): string {
  const gates = team.phases.filter((p) => p.review).length;
  const realtime = team.config?.mode === "conversational" || team.config?.mode === "realtime"
    ? `<span class="tm-chip tm-chip--rt" title="New tasks on this team start with autopilot off">Manual default</span>`
    : "";
  const slack = team.config?.slackEnabled
    ? `<span class="tm-chip tm-chip--slack">Slack</span>`
    : "";
  const slash = team.config?.slashCommand
    ? `<span class="tm-chip">${escapeHtml(team.config.slashCommand)}</span>`
    : "";
  // A remote team is read-only: Duplicate in place of Export/Delete. Delete
  // comes back once its repo no longer ships it.
  const remote = team.remote
    ? `<span class="tm-chip tm-chip--remote" title="${team.remote.removedUpstream
        ? "The linked repository no longer has this team. It stays because tasks use it."
        : "From a linked repository. Read-only."}">${team.remote.removedUpstream ? "Removed upstream" : "Remote"}</span>`
    : "";
  const deleteBtn = `<button type="button" class="sk-btn sk-btn--sm sk-btn--danger" data-tm-delete="${escapeHtml(team.id)}"
        data-tm-name="${escapeHtml(team.name)}">Delete</button>`;
  const actions = team.remote
    ? `${opts.canDuplicate ? `<button type="button" class="sk-btn sk-btn--sm" data-tm-duplicate="${escapeHtml(team.id)}">Duplicate to edit</button>` : ""}
      ${team.remote.removedUpstream ? deleteBtn : ""}`
    : `<a class="sk-btn sk-btn--sm" href="/api/teams/export?id=${encodeURIComponent(team.id)}">Export</a>
      ${deleteBtn}`;
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
    ${remote || realtime || slack || slash ? `<div class="tm-phase__chips">${remote}${realtime}${slack}${slash}</div>` : ""}
    <div class="tm-card__actions">
      <a class="sk-btn sk-btn--sm" href="/teams/${escapeHtml(team.id)}">Open</a>
      ${actions}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Remote teams (experimental): linked GitHub repos + the teams each one ships.
// `remoteReposList` is the live unit: the add/remove routes swap it, the
// refresh route swaps one `remoteRepoBlock`, and ws/ui-push.ts pushes the list
// OOB on remote_team_repo:changed / team:changed. The add form sits outside it
// so a push never wipes what the operator is typing.
// ---------------------------------------------------------------------------

// The duplicate route is part of the (experimental) remote teams surface, so
// only cards inside this section offer it.
const remoteTeamCard = (team: LocalTeam): string => teamCard(team, { canDuplicate: true });

function repoSlug(url: string): string {
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(url);
  return m ? m[1]! : url;
}

const REPO_STATUS_LABEL: Record<RemoteTeamRepo["status"], string> = {
  pending: "Pending",
  syncing: "Syncing",
  ok: "Up to date",
  error: "Error",
};

/** One linked repo: status line, refresh/remove, errors, its team cards. */
export function remoteRepoBlock(repo: RemoteTeamRepo, teams: LocalTeam[]): string {
  const id = escapeHtml(repo.id);
  const busy = repo.status === "syncing";
  const meta = [
    repo.ref ? `ref ${escapeHtml(repo.ref)}` : "default branch",
    repo.lastCommit ? `commit ${escapeHtml(repo.lastCommit.slice(0, 7))}` : "",
    repo.lastSyncAt ? `synced ${escapeHtml(repo.lastSyncAt)} UTC` : "",
    `${teams.length} team${teams.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" &middot; ");
  const fileErrors = repo.teamErrors.length > 0
    ? `<ul class="tm-repo__errors">${repo.teamErrors
        .map((e) => `<li><code>${escapeHtml(e.path)}</code> ${escapeHtml(e.error)}</li>`).join("")}</ul>`
    : "";
  return `<div class="tm-repo" id="tm-repo-${id}">
    <div class="tm-repo__head">
      <div class="tm-repo__heading">
        <div class="tm-repo__name">${escapeHtml(repo.name ?? repoSlug(repo.url))}
          <span class="tm-chip tm-chip--repo-${escapeHtml(repo.status)}">${REPO_STATUS_LABEL[repo.status] ?? escapeHtml(repo.status)}</span>
        </div>
        <div class="tm-repo__meta"><span>${escapeHtml(repoSlug(repo.url))}</span> &middot; ${meta}</div>
      </div>
      <div class="tm-repo__actions">
        <button type="button" class="sk-btn sk-btn--sm" ${busy ? "disabled" : ""}
          hx-post="/api/remote-team-repos/${id}/refresh" hx-target="closest .tm-repo" hx-swap="outerHTML"
          hx-disabled-elt="this" title="Pull the latest team configs">${busy ? "Refreshing..." : "Refresh"}</button>
        <button type="button" class="sk-btn sk-btn--sm sk-btn--danger"
          hx-delete="/api/remote-team-repos/${id}" hx-target="#tm-remote-repos" hx-swap="outerHTML"
          hx-confirm="Unlink ${escapeHtml(repoSlug(repo.url))}? Its teams are removed. A team that tasks still use stays, marked Removed upstream.">Unlink</button>
      </div>
    </div>
    ${repo.lastError ? `<div class="tm-repo__error">${escapeHtml(repo.lastError)}</div>` : ""}
    ${fileErrors}
    ${teams.length > 0 ? `<div class="tm-grid">${teams.map(remoteTeamCard).join("")}</div>` : ""}
  </div>`;
}

/** Every linked repo, plus remote teams whose repo was unlinked (kept because tasks use them). */
export function remoteReposList(repos: RemoteTeamRepo[], teams: LocalTeam[], error?: string): string {
  const repoIds = new Set(repos.map((r) => r.id));
  const blocks = repos
    .map((r) => remoteRepoBlock(r, teams.filter((t) => t.remote?.repoId === r.id)))
    .join("");
  const orphans = teams.filter((t) => t.remote && !repoIds.has(t.remote.repoId));
  return `<div id="tm-remote-repos" class="tm-remote__repos">
    ${error ? `<div class="tm-repo__error">${escapeHtml(error)}</div>` : ""}
    ${repos.length === 0 && orphans.length === 0 ? `<div class="sk-text-sm sk-muted">No repositories linked.</div>` : ""}
    ${blocks}
    ${orphans.length > 0 ? `<div class="tm-repo">
      <div class="tm-repo__name">Unlinked repositories</div>
      <div class="tm-grid">${orphans.map(remoteTeamCard).join("")}</div>
    </div>` : ""}
  </div>`;
}

function remoteTeamsSection(repos: RemoteTeamRepo[], teams: LocalTeam[]): string {
  return `<section class="tm-remote">
    <div class="tm-remote__head">
      <h2 class="tm-remote__title">Remote teams</h2>
      <div class="tm-remote__sub">Link a GitHub repository of team configs (a <code>skipper-teams.json</code> manifest, or <code>teams/*.json</code>). Skipper clones it with the git credentials of this machine. Remote teams are read-only.</div>
    </div>
    <form class="tm-remote__add" hx-post="/api/remote-team-repos" hx-target="#tm-remote-repos" hx-swap="outerHTML"
      hx-disabled-elt="find button" hx-on::after-request="if (event.detail.successful &amp;&amp; !document.querySelector('#tm-remote-repos > .tm-repo__error')) this.reset()">
      <input class="sk-input" name="url" required placeholder="https://github.com/owner/repo" aria-label="Repository URL">
      <input class="sk-input tm-remote__ref" name="ref" placeholder="Branch or tag (optional)" aria-label="Branch or tag">
      <button type="submit" class="sk-btn sk-btn--sm sk-btn--primary">Link repository</button>
    </form>
    ${remoteReposList(repos, teams)}
  </section>`;
}

export function teamsPage(vm: TeamsPageViewModel): string {
  // With the section on, remote teams render under their repo, not in the grid.
  const gridTeams = vm.remoteRepos ? vm.teams.filter((t) => !t.remote) : vm.teams;
  const cards = gridTeams.map((t) => teamCard(t)).join("");

  const body = gridTeams.length === 0
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
      ${vm.remoteRepos ? remoteTeamsSection(vm.remoteRepos, vm.teams.filter((t) => t.remote)) : ""}
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

      // Delegated: remote team cards are re-rendered by htmx swaps + WS pushes.
      document.addEventListener('click', async function(ev){
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-tm-delete],[data-tm-duplicate]') : null;
        if (!btn) return;
        if (btn.hasAttribute('data-tm-duplicate')) {
          btn.disabled = true;
          var dup = await fetch('/api/teams/' + encodeURIComponent(btn.getAttribute('data-tm-duplicate')) + '/duplicate', { method: 'POST' });
          var data = await dup.json().catch(function(){ return {}; });
          if (dup.ok && data.id) window.location.href = '/teams/' + encodeURIComponent(data.id);
          else btn.disabled = false;
          return;
        }
        var id = btn.getAttribute('data-tm-delete');
        var name = btn.getAttribute('data-tm-name');
        if (!window.confirm('Delete team "' + name + '"? This cannot be undone.')) return;
        var res = await fetch('/api/teams/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.ok) window.location.reload();
      });
    })();
    </script>
  `, "/teams");
}
