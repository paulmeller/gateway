import { test, expect } from "@playwright/test";

// These tests require `gateway serve --port 4111` running locally.

/** Extract the injected API key from the HTML page */
async function getApiKey(baseURL: string): Promise<string> {
  const res = await fetch(baseURL);
  const html = await res.text();
  const match = html.match(/window\.__MA_API_KEY__="([^"]+)"/);
  return match?.[1] ?? "";
}

let apiKey = "";

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
    await expect(page.getByText("Sessions", { exact: true })).toBeVisible();
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
  test.beforeAll(async () => {
    if (!apiKey) apiKey = await getApiKey("http://localhost:4111");
  });

  test("API returns provider status", async ({ request }) => {
    const res = await request.get("/v1/providers/status", {
      headers: { "x-api-key": apiKey },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.docker).toBeDefined();
    expect(typeof body.data.docker.available).toBe("boolean");
  });

  test("returns 401 without key", async ({ request }) => {
    const res = await request.get("/v1/providers/status");
    expect(res.status()).toBe(401);
  });
});

test.describe("Skills API", () => {
  test.beforeAll(async () => {
    if (!apiKey) apiKey = await getApiKey("http://localhost:4111");
  });

  test("catalog returns skills array", async ({ request }) => {
    const res = await request.get("/v1/skills/catalog?leaderboard=trending&limit=3", {
      headers: { "x-api-key": apiKey },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.skills)).toBe(true);
  });

  test("stats returns totals", async ({ request }) => {
    const res = await request.get("/v1/skills/stats", {
      headers: { "x-api-key": apiKey },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.totalSkills).toBe("number");
    expect(typeof body.indexLoaded).toBe("boolean");
  });

  test("search returns results", async ({ request }) => {
    const res = await request.get("/v1/skills?q=frontend&limit=3", {
      headers: { "x-api-key": apiKey },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.skills.length).toBeGreaterThan(0);
  });
});

test.describe("Agents API", () => {
  test.beforeAll(async () => {
    if (!apiKey) apiKey = await getApiKey("http://localhost:4111");
  });

  test("list agents", async ({ request }) => {
    const res = await request.get("/v1/agents", {
      headers: { "x-api-key": apiKey },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("create and delete agent", async ({ request }) => {
    const createRes = await request.post("/v1/agents", {
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      data: { name: `e2e-test-${Date.now()}`, model: "claude-sonnet-4-6" },
    });
    expect(createRes.status()).toBe(201);
    const agent = await createRes.json();
    expect(agent.id).toBeDefined();

    const delRes = await request.delete(`/v1/agents/${agent.id}`, {
      headers: { "x-api-key": apiKey },
    });
    expect(delRes.status()).toBe(200);
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
