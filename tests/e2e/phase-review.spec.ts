import { test, expect, type APIRequestContext } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const SOFTWARE_TEAM_NAME = "Software Team";
const AGENT_WORK_TIMEOUT = 180_000; // 3 min for agents to complete a phase
const POLL_INTERVAL = 5_000; // 5s polling

/** Poll the task API until the predicate is true or timeout */
async function waitForTask(
  request: APIRequestContext,
  taskId: string,
  predicate: (task: any) => boolean,
  timeoutMs = AGENT_WORK_TIMEOUT,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await request.get(`/api/tasks/${taskId}`);
    if (resp.ok()) {
      const task = await resp.json();
      if (predicate(task)) return task;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Task ${taskId} did not reach expected state within ${timeoutMs / 1000}s`);
}

/** Create a task via API with auto-approve, returns task id */
async function createTask(
  request: APIRequestContext,
  title: string,
  description: string,
  teamId: string,
): Promise<string> {
  const form = new FormData();
  form.append("title", title);
  form.append("description", description);
  form.append("teamId", teamId);
  form.append("autoApprove", "1");

  const resp = await request.post("/api/tasks", {
    multipart: {
      title,
      description,
      teamId,
      autoApprove: "1",
    },
  });
  // The response either redirects or returns HTML. Get the task ID from the tasks list.
  const tasksResp = await request.get("/api/tasks");
  const tasks = await tasksResp.json();
  const task = tasks.find((t: any) => t.title === title && t.status !== "completed" && t.status !== "failed");
  if (!task) throw new Error(`Could not find created task "${title}"`);
  return task.id;
}

test.describe("Phase Review E2E", () => {
  let softwareTeamId: string;

  test.beforeAll(async ({ request }) => {
    // Find the Software Team
    const teamsResp = await request.get("/api/teams");
    const teams = await teamsResp.json();
    const team = teams.find((t: any) => t.name === SOFTWARE_TEAM_NAME);
    expect(team, `"${SOFTWARE_TEAM_NAME}" must exist`).toBeTruthy();
    softwareTeamId = team.id;
  });

  test("approve phase: create hello-world.md task, review, approve, complete", async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000); // 10 min total — agents need time

    // 1. Create the task
    const taskTitle = `E2E-approve-${Date.now()}`;
    const taskId = await createTask(
      request,
      taskTitle,
      "Create a file called hello-world.md in the root of the skipper repo with the content '# Hello World'. Do nothing else.",
      softwareTeamId,
    );

    // 2. Wait for Planning phase to finish → needs_review = true
    console.log(`[approve] Task ${taskId} created. Waiting for phase review...`);
    await waitForTask(request, taskId, (t) => t.needs_review === 1 || t.needs_review === true, AGENT_WORK_TIMEOUT);
    console.log("[approve] Phase review required. Checking dashboard...");

    // 3. Verify dashboard shows the review banner
    await page.goto("/");
    // Click the task in the sidebar to load it
    const sidebarItem = page.locator(`.mc-sidebar__item:has-text("${taskTitle}")`).first();
    if (await sidebarItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sidebarItem.click();
      await page.waitForTimeout(2000);
    } else {
      // Reload — the task might appear after refresh
      await page.reload();
      await page.waitForTimeout(2000);
    }

    // The review banner should be visible on the dashboard
    const reviewBanner = page.locator(".mc-escalation:has-text('Phase review required')");
    await expect(reviewBanner).toBeVisible({ timeout: 10_000 });
    console.log("[approve] Review banner visible on dashboard.");

    // The approve button should be present
    const approveBtn = page.locator(`button:has-text("Approve")`).first();
    await expect(approveBtn).toBeVisible();

    // 4. Go to task page and verify review state there too
    await page.goto(`/tasks/${taskId}`);
    await page.waitForTimeout(2000);

    // Check that the task execution page shows the review state
    const taskPage = page.locator("body");
    await expect(taskPage).toContainText("review", { ignoreCase: true, timeout: 5000 });

    // 5. Approve the phase via the API (more reliable than clicking HTMX buttons in tests)
    console.log("[approve] Approving phase...");
    const approveResp = await request.post(`/api/tasks/${taskId}/approve-phase`);
    expect(approveResp.ok()).toBe(true);

    // 6. Wait for task to complete (implementation + QA phases)
    console.log("[approve] Phase approved. Waiting for task completion...");
    const finalTask = await waitForTask(
      request,
      taskId,
      (t) => t.status === "completed" || t.status === "failed",
      AGENT_WORK_TIMEOUT * 2, // Implementation + QA can take a while
    );

    console.log(`[approve] Task finished with status: ${finalTask.status}`);
    expect(finalTask.status).toBe("completed");

    // 7. Verify the dashboard shows the task as completed
    await page.goto("/");
    await page.waitForTimeout(2000);

    // Check task no longer shows review banner
    const reviewBannerGone = page.locator(".mc-escalation:has-text('Phase review required')");
    await expect(reviewBannerGone).not.toBeVisible({ timeout: 5000 });

    // Clean up — delete the created file
    // cleanup
    try {
      execSync("rm -f hello-world.md", { cwd: process.cwd() });
    } catch { /* ignore */ }
  });

  test("reject phase: create foobar.md, reject with barfoo instruction, verify completion", async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000); // 15 min — reject adds an extra cycle

    // 1. Create the task
    const taskTitle = `E2E-reject-${Date.now()}`;
    const taskId = await createTask(
      request,
      taskTitle,
      "Create a file called foobar.md in the root of the skipper repo with the content '# Foobar'. Do nothing else.",
      softwareTeamId,
    );

    // 2. Wait for Planning phase to finish → needs_review = true
    console.log(`[reject] Task ${taskId} created. Waiting for phase review...`);
    await waitForTask(request, taskId, (t) => t.needs_review === 1 || t.needs_review === true, AGENT_WORK_TIMEOUT);
    console.log("[reject] Phase review required. Checking dashboard...");

    // 3. Verify dashboard shows the review banner
    await page.goto("/");
    const sidebarItem = page.locator(`.mc-sidebar__item:has-text("${taskTitle}")`).first();
    if (await sidebarItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sidebarItem.click();
      await page.waitForTimeout(2000);
    } else {
      await page.reload();
      await page.waitForTimeout(2000);
    }

    const reviewBanner = page.locator(".mc-escalation:has-text('Phase review required')");
    await expect(reviewBanner).toBeVisible({ timeout: 10_000 });
    console.log("[reject] Review banner visible. Rejecting phase...");

    // 4. Reject with instruction to rename the file
    const rejectResp = await request.post(`/api/tasks/${taskId}/reject-phase`, {
      data: {
        message: "Do NOT create foobar.md. Instead, create a file called barfoo.md with the content '# Barfoo'. The filename must be barfoo.md, not foobar.md.",
      },
    });
    expect(rejectResp.ok()).toBe(true);

    // 5. Wait for planning to re-run and hit review again
    console.log("[reject] Phase rejected. Waiting for re-planning review...");
    // First wait for needs_review to go false (rejection processed)
    await waitForTask(request, taskId, (t) => t.needs_review === 0 || t.needs_review === false, 30_000);
    // Then wait for it to come back (re-planning complete)
    await waitForTask(request, taskId, (t) => t.needs_review === 1 || t.needs_review === true, AGENT_WORK_TIMEOUT);
    console.log("[reject] Re-planning complete. Review required again. Approving...");

    // 6. Verify the review banner shows again on the dashboard
    await page.goto("/");
    await page.waitForTimeout(2000);
    const sidebarItem2 = page.locator(`.mc-sidebar__item:has-text("${taskTitle}")`).first();
    if (await sidebarItem2.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sidebarItem2.click();
      await page.waitForTimeout(2000);
    }
    const reviewBanner2 = page.locator(".mc-escalation:has-text('Phase review required')");
    await expect(reviewBanner2).toBeVisible({ timeout: 10_000 });

    // 7. Approve this time
    const approveResp = await request.post(`/api/tasks/${taskId}/approve-phase`);
    expect(approveResp.ok()).toBe(true);
    console.log("[reject] Second review approved. Waiting for completion...");

    // 8. Wait for completion
    const finalTask = await waitForTask(
      request,
      taskId,
      (t) => t.status === "completed" || t.status === "failed",
      AGENT_WORK_TIMEOUT * 2,
    );

    console.log(`[reject] Task finished with status: ${finalTask.status}`);
    expect(finalTask.status).toBe("completed");

    // 9. Verify barfoo.md exists and foobar.md does not
    const repoRoot = process.cwd();
    const barfooExists = existsSync(resolve(repoRoot, "barfoo.md"));
    const foobarExists = existsSync(resolve(repoRoot, "foobar.md"));
    console.log(`[reject] barfoo.md exists: ${barfooExists}, foobar.md exists: ${foobarExists}`);
    expect(barfooExists).toBe(true);

    // Clean up
    // cleanup
    try {
      execSync("rm -f barfoo.md foobar.md", { cwd: repoRoot });
    } catch { /* ignore */ }
  });
});
