/**
 * Live integration test: verifies that the sprites provider waits for
 * container readiness before returning from create(). This reproduces the
 * bug where the second session's container creation succeeded but the
 * container wasn't ready for exec, causing httpExec: 502.
 *
 * Requires SPRITE_TOKEN in .env or environment.
 * Skipped automatically if the token is not available.
 */

import { describe, it, expect, afterAll } from "vitest";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from the repo root
const __dirname2 = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname2, "../../../.env") });

const SPRITE_TOKEN = process.env.SPRITE_TOKEN;
const hasToken = !!SPRITE_TOKEN;

// Containers created during the test — cleaned up in afterAll
const containersToClean: string[] = [];

describe.skipIf(!hasToken)("sprites readiness (live)", () => {
  afterAll(async () => {
    // Clean up any containers created during the test
    if (!hasToken) return;
    const { deleteSprite } = await import("../src/containers/client");
    for (const name of containersToClean) {
      await deleteSprite(name, SPRITE_TOKEN).catch(() => {});
    }
  });

  it("create() returns a container that is immediately exec-ready", async () => {
    const { spritesProvider } = await import("../src/providers/sprites");
    const name = `ca-test-ready-${Date.now()}`;
    containersToClean.push(name);

    // Create container — should block until running
    await spritesProvider.create({ name, secrets: { SPRITE_TOKEN: SPRITE_TOKEN! } });

    // Exec should succeed immediately — this is what failed with 502 before
    const result = await spritesProvider.exec(name, ["echo", "ready"], {
      secrets: { SPRITE_TOKEN: SPRITE_TOKEN! },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toContain("ready");
  }, 60_000);

  it("second container is also exec-ready (the failing scenario)", async () => {
    const { spritesProvider } = await import("../src/providers/sprites");

    // Create first container (simulates session 1)
    const name1 = `ca-test-seq1-${Date.now()}`;
    containersToClean.push(name1);
    await spritesProvider.create({ name: name1, secrets: { SPRITE_TOKEN: SPRITE_TOKEN! } });

    // Don't delete it — leave it alive (simulates session 1 still idle)

    // Create second container (simulates session 2 — previously failed with 502)
    const name2 = `ca-test-seq2-${Date.now()}`;
    containersToClean.push(name2);
    await spritesProvider.create({ name: name2, secrets: { SPRITE_TOKEN: SPRITE_TOKEN! } });

    // Exec on the second container — this is the call that was failing
    const result = await spritesProvider.exec(name2, ["echo", "second-ready"], {
      secrets: { SPRITE_TOKEN: SPRITE_TOKEN! },
      timeoutMs: 10_000,
    });
    expect(result.stdout).toContain("second-ready");
  }, 120_000);
});
