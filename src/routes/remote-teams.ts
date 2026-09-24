import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { htmlResponse, parseRequestBody } from "./utils";
import { listLocalTeams } from "../teams/local-teams";
import {
  addRemoteTeamRepo,
  duplicateTeamToLocal,
  getRemoteTeamRepo,
  listRemoteTeamRepos,
  listRepoTeams,
  removeRemoteTeamRepo,
  syncRemoteTeamRepo,
} from "../teams/remote-repos";
import { remoteRepoBlock, remoteReposList } from "../html/pages/teams.page";

/**
 * Remote team repos (experimental; 404 without `--experimental`): link a GitHub
 * repository of team configs, refresh it, unlink it. See src/teams/remote-repos.ts.
 *
 * UI contract: every mutation emits `remote_team_repo:changed` / `team:changed`
 * from the store, so other surfaces reconcile from the event. An htmx caller
 * gets back just the element it swaps in place: the repo list for link/unlink,
 * the one repo block for refresh.
 */
export function registerRemoteTeamRoutes(): void {
  if (!isExperimental()) return;
  const db = getDb();

  const isHtmx = (req: Request) => !!req.headers.get("HX-Request");
  const listHtml = (error?: string) =>
    remoteReposList(listRemoteTeamRepos(db), listLocalTeams(db).filter((t) => t.remote), error);

  addRoute("GET", "/api/remote-team-repos", () => Response.json(listRemoteTeamRepos(db)));

  // Link + first sync. The clone can take seconds; the request waits for it so
  // the caller's swap shows the loaded teams (or the git error) at once.
  addRoute("POST", "/api/remote-team-repos", async (req) => {
    let added;
    try {
      const body = await parseRequestBody<{ url?: string; ref?: string }>(req);
      added = addRemoteTeamRepo(db, { url: String(body.url ?? ""), ref: body.ref != null ? String(body.ref) : null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return isHtmx(req) ? htmlResponse(listHtml(error)) : Response.json({ error }, { status: 400 });
    }
    const repo = await syncRemoteTeamRepo(db, added.id);
    return isHtmx(req) ? htmlResponse(listHtml()) : Response.json(repo, { status: 201 });
  });

  addRoute("POST", "/api/remote-team-repos/:id/refresh", async (req, params) => {
    const id = params.id!;
    if (!getRemoteTeamRepo(db, id)) return Response.json({ error: "Repository not found" }, { status: 404 });
    const repo = await syncRemoteTeamRepo(db, id);
    if (!repo) return Response.json({ error: "Repository not found" }, { status: 404 });
    return isHtmx(req) ? htmlResponse(remoteRepoBlock(repo, listRepoTeams(db, id))) : Response.json(repo);
  });

  addRoute("DELETE", "/api/remote-team-repos/:id", (req, params) => {
    if (!removeRemoteTeamRepo(db, params.id!)) return Response.json({ error: "Repository not found" }, { status: 404 });
    return isHtmx(req) ? htmlResponse(listHtml()) : Response.json({ deleted: true });
  });

  // An editable local copy of a (read-only) team.
  addRoute("POST", "/api/teams/:id/duplicate", (_req, params) => {
    try {
      return Response.json(duplicateTeamToLocal(db, params.id!), { status: 201 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
    }
  });
}
