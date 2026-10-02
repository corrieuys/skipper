import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { htmlResponse, parseRequestBody } from "./utils";
import { getOpenEscalationCount, isDaemonPaused } from "../data/queries";
import {
  type Improvement,
  approveImprovement,
  countPendingImprovements,
  editImprovement,
  getImprovement,
  improvementState,
  listImprovements,
  rejectImprovement,
  setImprovementsAutoApprove,
  setImprovementsEnabled,
} from "../improvements/manager";
import { improvementCard, improvementEditCard } from "../html/fragments/improvement-card.fragment";
import { improvementsPage } from "../html/pages/improvements.page";

/**
 * Improvements page (experimental; 404 without `--experimental`): review what
 * root Skippers staged (src/improvements). Every action answers with the one
 * card it changed (htmx `closest .imp-card` outerHTML self-swap). The writers
 * emit `improvement:changed` (plus team:changed / recurring:changed on
 * approve), so other tabs and clients reconcile from the event.
 */
export function registerImprovementRoutes(): void {
  if (!isExperimental()) return;
  const db = getDb();

  const card = (imp: Improvement, error?: string) => htmlResponse(improvementCard(imp, improvementState(db, imp), { error }));
  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const notFound = () => new Response("Improvement not found", { status: 404 });

  addRoute("GET", "/improvements", (req) => {
    const view = new URL(req.url).searchParams.get("view") === "history" ? "history" : "pending";
    const rows = listImprovements(db, view === "pending" ? { status: "pending" } : {});
    return htmlResponse(improvementsPage({
      view,
      items: rows.map((imp) => ({ imp, state: improvementState(db, imp) })),
      pendingCount: countPendingImprovements(db),
      daemonState: isDaemonPaused(db) ? "paused" : "running",
      daemonUptime: process.uptime(),
      escalationCount: getOpenEscalationCount(db),
    }));
  });

  // Config page toggle (checkbox posts itself; hx-swap none, like parallel-tasks).
  addRoute("POST", "/api/settings/improvements-auto-approve", async (req) => {
    // An unchecked box posts no field; a client may also send no body at all.
    const body = await parseRequestBody<{ enabled?: string | boolean }>(req).catch(() => ({} as { enabled?: string | boolean }));
    const on = body.enabled === true || body.enabled === "on" || body.enabled === "true";
    setImprovementsAutoApprove(db, on);
    return Response.json({ enabled: on });
  });

  // Config page on/off switch: off = no housekeeping tools or prompt block for any root Skipper.
  addRoute("POST", "/api/settings/improvements-enabled", async (req) => {
    const body = await parseRequestBody<{ enabled?: string | boolean }>(req).catch(() => ({} as { enabled?: string | boolean }));
    const on = body.enabled === true || body.enabled === "on" || body.enabled === "true";
    setImprovementsEnabled(db, on);
    return Response.json({ enabled: on });
  });

  addRoute("GET", "/api/improvements", (req) => {
    const status = new URL(req.url).searchParams.get("status");
    const filter = status === "pending" || status === "approved" || status === "rejected" ? { status } as const : {};
    return Response.json(listImprovements(db, filter));
  });

  addRoute("GET", "/fragments/improvements/:id", (_req, params) => {
    const imp = getImprovement(db, params.id!);
    return imp ? card(imp) : notFound();
  });

  addRoute("GET", "/fragments/improvements/:id/edit", (_req, params) => {
    const imp = getImprovement(db, params.id!);
    if (!imp) return notFound();
    if (imp.status !== "pending") return card(imp, `This improvement is already ${imp.status}.`);
    return htmlResponse(improvementEditCard(imp, improvementState(db, imp)));
  });

  addRoute("POST", "/api/improvements/:id/edit", async (req, params) => {
    const imp = getImprovement(db, params.id!);
    if (!imp) return notFound();
    const body = await parseRequestBody<{ proposed_text?: string }>(req);
    const text = typeof body.proposed_text === "string" ? body.proposed_text.replace(/\r\n/g, "\n") : "";
    try {
      return card(editImprovement(db, imp.id, text));
    } catch (err) {
      // Keep the operator's text in the editor so nothing typed is lost.
      return htmlResponse(improvementEditCard({ ...imp, proposed_text: text }, improvementState(db, imp), errorMessage(err)));
    }
  });

  addRoute("POST", "/api/improvements/:id/approve", (_req, params) => {
    const imp = getImprovement(db, params.id!);
    if (!imp) return notFound();
    try {
      return card(approveImprovement(db, imp.id));
    } catch (err) {
      return card(getImprovement(db, imp.id)!, errorMessage(err));
    }
  });

  addRoute("POST", "/api/improvements/:id/reject", (_req, params) => {
    const imp = getImprovement(db, params.id!);
    if (!imp) return notFound();
    try {
      return card(rejectImprovement(db, imp.id));
    } catch (err) {
      return card(getImprovement(db, imp.id)!, errorMessage(err));
    }
  });
}
