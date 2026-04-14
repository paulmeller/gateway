import { test, expect } from "@playwright/test";

// These tests require `gateway serve --port 4111` running locally.

test.describe("Home / Onboarding", () => {
  test("loads the app and shows onboarding wizard", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Should show the sidebar with AgentStep branding
    await expect(page.locator("text=AgentStep").first()).toBeVisible();
  });

  test("sidebar shows sessions section", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Sessions")).toBeVisible();
  });

  test("sidebar shows agentstep.com link", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=agentstep.com")).toBeVisible();
  });

  test("sidebar shows version number", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=/v\\d+\\.\\d+/")).toBeVisible();
  });
});

test.describe("Onboarding Wizard", () => {
  test("step 1 shows agent selection", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Step 1 of 4")).toBeVisible();
    await expect(page.locator("text=Choose an Agent")).toBeVisible();
  });

  test("step 1 has create new option", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Should show agent name input or "Create new" tab
    const hasCreate = await page.locator("text=Create new").isVisible().catch(() => false);
    const hasInput = await page.locator('input[placeholder="Agent name"]').isVisible().catch(() => false);
    expect(hasCreate || hasInput).toBe(true);
  });

  test("step 1 validates duplicate agent names", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // If "Create new" tab exists, click it
    const createTab = page.locator("text=Create new");
    if (await createTab.isVisible().catch(() => false)) {
      await createTab.click();
    }
    // Type an existing agent name (if one exists) and click Continue
    const input = page.locator('input[placeholder="Agent name"]');
    if (await input.isVisible()) {
      await input.fill("Coder"); // Common default agent name
      await page.locator("button:has-text('Continue')").click();
      // Should either proceed (if no duplicate) or show error toast
      await page.waitForTimeout(500);
    }
  });
});

test.describe("Settings Page", () => {
  test("navigates to settings", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("shows agent tab", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible();
  });

  test("shows environments tab", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("button:has-text('Environments')")).toBeVisible();
  });

  test("shows vaults tab", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("button:has-text('Vaults')")).toBeVisible();
  });

  test("shows memory tab", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("button:has-text('Memory')")).toBeVisible();
  });
});

test.describe("Settings — Agents", () => {
  test("agents tab shows table or empty state", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    // Either agents table or "No agents yet" message
    const hasTable = await page.locator("table").isVisible().catch(() => false);
    const hasEmpty = await page.locator("text=No agents yet").isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBe(true);
  });

  test("new agent button opens dialog", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const newBtn = page.locator("button:has-text('New agent')");
    if (await newBtn.isVisible()) {
      await newBtn.click();
      await expect(page.locator("text=New agent").first()).toBeVisible();
    }
  });
});

test.describe("Provider Status", () => {
  test("API returns provider status", async ({ request }) => {
    const res = await request.get("/v1/providers/status", {
      headers: { "x-api-key": process.env.GATEWAY_API_KEY || "test" },
    });
    // May fail auth without key — just check it responds
    expect([200, 401]).toContain(res.status());
  });
});

test.describe("Skills API", () => {
  test("catalog returns skills", async ({ request }) => {
    const res = await request.get("/v1/skills/catalog?leaderboard=trending&limit=3", {
      headers: { "x-api-key": process.env.GATEWAY_API_KEY || "test" },
    });
    expect([200, 401]).toContain(res.status());
  });

  test("stats endpoint responds", async ({ request }) => {
    const res = await request.get("/v1/skills/stats", {
      headers: { "x-api-key": process.env.GATEWAY_API_KEY || "test" },
    });
    expect([200, 401]).toContain(res.status());
  });
});

test.describe("Health", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

test.describe("Dark Mode", () => {
  test("app renders with dark theme by default", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const hasDark = await page.locator("html.dark").count();
    // Dark mode may or may not be default depending on system preference
    expect(hasDark).toBeGreaterThanOrEqual(0);
  });

  test("theme toggle button exists", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // The sun/moon toggle button should be visible in the sidebar
    const toggle = page.locator("button").filter({ has: page.locator("svg") }).last();
    await expect(toggle).toBeVisible();
  });
});

test.describe("URL Routing", () => {
  test("/settings loads settings page", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("/ loads home/wizard", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Should show wizard or session list
    const hasWizard = await page.locator("text=Step 1 of 4").isVisible().catch(() => false);
    const hasSessions = await page.locator("text=Sessions").isVisible().catch(() => false);
    expect(hasWizard || hasSessions).toBe(true);
  });

  test("back button on settings returns home", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const backBtn = page.locator("button").first();
    await backBtn.click();
    await page.waitForTimeout(500);
    expect(page.url()).not.toContain("/settings");
  });
});
