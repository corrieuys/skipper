import { test, expect } from "@playwright/test";

test.describe("V2 Command Center", () => {
  test("loads workspace layout", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Skipper/);

    // Navbar
    await expect(page.locator(".sk-navbar")).toBeVisible();
    await expect(page.locator(".sk-navbar__brand")).toBeVisible();

    // Workspace: sidebar + main
    await expect(page.locator(".mc-workspace")).toBeVisible();
    await expect(page.locator(".mc-sidebar")).toBeVisible();
    await expect(page.locator(".mc-main")).toBeVisible();

    // skipper.js loaded
    const hasSkipper = await page.evaluate(() => typeof (window as any).Skipper === "object");
    expect(hasSkipper).toBe(true);
  });

  test("sidebar shows task list", async ({ page }) => {
    await page.goto("/");
    // Should have task items in sidebar
    const items = await page.locator(".mc-sidebar__item").count();
    expect(items).toBeGreaterThan(0);
    // Should have + New Task button
    await expect(page.locator(".mc-sidebar__create")).toBeVisible();
  });

  test("idle state has create form and stats", async ({ page }) => {
    await page.goto("/");
    const idle = page.locator(".mc-idle");
    if (await idle.isVisible().catch(() => false)) {
      await expect(page.locator(".mc-idle__command-label")).toContainText("New Mission");
      await expect(page.locator(".mc-idle__input")).toBeVisible();
      await expect(page.locator(".mc-idle__go")).toBeVisible();
      await expect(page.locator(".mc-stat-card")).toHaveCount(4);
      await expect(page.locator(".mc-idle__feed-title")).toContainText("Recent Activity");
    }
  });

  test("navbar shows daemon status", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".sk-navbar__right")).toBeVisible();
    await expect(page.locator(".sk-navbar__right")).toContainText("running");
  });

  test("contains WebSocket topic subscription", async ({ page }) => {
    await page.goto("/");
    const topics = await page.locator("body").getAttribute("data-ws-topics");
    expect(topics).toBe("dashboard");
  });
});

test.describe("V2 Task List", () => {
  test("loads task list page", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page).toHaveTitle(/Tasks.*Skipper/);
    await expect(page.locator(".sk-page-header__title")).toContainText("Tasks");
    await expect(page.locator(".sk-table")).toBeVisible();
  });

  test("has new task button", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.locator('a:has-text("+ New Task")')).toBeVisible();
  });

  test("contains tasks topic subscription", async ({ page }) => {
    await page.goto("/tasks");
    const topics = await page.locator("body").getAttribute("data-ws-topics");
    expect(topics).toBe("tasks");
  });
});

test.describe("V2 Task Execution", () => {
  let taskId: string;

  test.beforeAll(async ({ request }) => {
    const tasksResp = await request.get("/api/tasks");
    const tasks = await tasksResp.json();
    taskId = tasks[0]?.id;
  });

  test("loads task execution page", async ({ page }) => {
    test.skip(!taskId, "No task available");
    await page.goto(`/tasks/${taskId}`);
    await expect(page).toHaveTitle(/Task:.*Skipper/);
    await expect(page.locator(".sk-page-header__back")).toContainText("Tasks");
    await expect(page.locator(".sk-badge").first()).toBeVisible();
  });

  test("shows agent tree panel", async ({ page }) => {
    test.skip(!taskId, "No task available");
    await page.goto(`/tasks/${taskId}`);
    const treePanel = page.locator("#sk-agent-tree");
    await expect(treePanel).toBeVisible();
  });

  test("shows notes panel with add form", async ({ page }) => {
    test.skip(!taskId, "No task available");
    await page.goto(`/tasks/${taskId}`);
    const notesPanel = page.locator("#sk-notes");
    await expect(notesPanel).toBeVisible();
    await expect(notesPanel.locator('input[name="content"]')).toBeVisible();
  });

  test("shows artifacts panel", async ({ page }) => {
    test.skip(!taskId, "No task available");
    await page.goto(`/tasks/${taskId}`);
    await expect(page.locator("#sk-artifacts")).toBeVisible();
  });

  test("shows lifecycle actions", async ({ page }) => {
    test.skip(!taskId, "No task available");
    await page.goto(`/tasks/${taskId}`);
    const actionsPanel = page.locator('.sk-panel:has(.sk-panel__title:has-text("Actions"))');
    await expect(actionsPanel).toBeVisible();
  });

  test("has correct WS topics", async ({ page }) => {
    test.skip(!taskId, "No task available");
    await page.goto(`/tasks/${taskId}`);
    const topics = await page.locator("body").getAttribute("data-ws-topics");
    expect(topics).toContain(`task:${taskId}`);
  });
});

test.describe("V2 Escalation Queue", () => {
  test("loads escalation page", async ({ page }) => {
    await page.goto("/escalations");
    await expect(page).toHaveTitle(/Escalations.*Skipper/);
    await expect(page.locator(".sk-page-header__title")).toContainText("Escalations");
  });

  test("shows open and resolved sections", async ({ page }) => {
    await page.goto("/escalations");
    await expect(page.locator("h2.sk-eyebrow").first()).toContainText("Open");
    await expect(page.locator("h2.sk-eyebrow").nth(1)).toContainText("Resolved");
  });

  test("has escalations topic subscription", async ({ page }) => {
    await page.goto("/escalations");
    const topics = await page.locator("body").getAttribute("data-ws-topics");
    expect(topics).toBe("escalations");
  });
});

test.describe("V2 Design System", () => {
  test("loads sk- CSS custom properties", async ({ page }) => {
    await page.goto("/");
    const hasSKVars = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return root.getPropertyValue("--sk-accent-primary").trim() !== "";
    });
    expect(hasSKVars).toBe(true);
  });

  test("skipper.js modal system works", async ({ page }) => {
    await page.goto("/");
    const hasModal = await page.evaluate(() => {
      const S = (window as any).Skipper;
      return S && typeof S.modal.open === "function" && typeof S.modal.close === "function";
    });
    expect(hasModal).toBe(true);
  });

  test("skipper.js event delegation handles data-sk attributes", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const modal = document.createElement("div");
      modal.id = "test-modal";
      modal.className = "sk-modal";
      modal.setAttribute("data-sk-modal-backdrop", "");
      modal.innerHTML = '<div class="sk-modal__content"><button data-sk-modal-close="test-modal">Close</button></div>';
      document.body.appendChild(modal);
      const openBtn = document.createElement("button");
      openBtn.id = "open-test-modal";
      openBtn.setAttribute("data-sk-modal-open", "test-modal");
      document.body.appendChild(openBtn);
    });
    await page.click("#open-test-modal");
    await expect(page.locator("#test-modal")).toHaveClass(/sk-modal--open/);
    await page.click('[data-sk-modal-close="test-modal"]');
    await expect(page.locator("#test-modal")).not.toHaveClass(/sk-modal--open/);
  });
});

test.describe("V2 Navigation", () => {
  test("sidebar task click loads task in main area", async ({ page }) => {
    await page.goto("/");
    // Click first task
    await page.locator(".mc-sidebar__item").first().click();
    await page.waitForTimeout(1000);
    // Main area should show task header
    await expect(page.locator(".mc-task-header")).toBeVisible();
    // Tabs should be present
    await expect(page.locator(".mc-tab")).toHaveCount(4);
  });

  test("navigate to tasks list page", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.locator(".sk-page-header__title")).toContainText("Tasks");
  });
});

test.describe("V2 Cross-cutting", () => {
  test("escalation navbar badge on all pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sk-nav-escalation-count")).toBeAttached();
    await page.goto("/tasks");
    await expect(page.locator("#sk-nav-escalation-count")).toBeAttached();
    await page.goto("/escalations");
    await expect(page.locator("#sk-nav-escalation-count")).toBeAttached();
  });

  test("all v2 pages load without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/");
    await page.goto("/tasks");
    await page.goto("/escalations");
    expect(errors).toEqual([]);
  });
});
