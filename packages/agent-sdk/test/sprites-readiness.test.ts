/**
 * Tests for the sprites provider's container readiness wait.
 *
 * After createSprite, the container may be in "cold" or "warm" state. Exec
 * calls will fail with 502 until the container transitions to "running".
 * The sprites provider must poll getSprite until the container is ready
 * before returning from create().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the containers/client module
// ---------------------------------------------------------------------------
const mockCreateSprite = vi.fn();
const mockGetSprite = vi.fn();
const mockDeleteSprite = vi.fn();
const mockListSprites = vi.fn();
const mockHttpExec = vi.fn();

vi.mock("../src/containers/client", () => ({
  createSprite: (...args: unknown[]) => mockCreateSprite(...args),
  getSprite: (...args: unknown[]) => mockGetSprite(...args),
  deleteSprite: (...args: unknown[]) => mockDeleteSprite(...args),
  listSprites: (...args: unknown[]) => mockListSprites(...args),
  httpExec: (...args: unknown[]) => mockHttpExec(...args),
}));

vi.mock("../src/containers/exec", () => ({
  startExec: vi.fn(),
}));

vi.mock("../src/config/index", () => ({
  getConfig: () => ({ spriteToken: "test-token" }),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered
// ---------------------------------------------------------------------------
import { spritesProvider } from "../src/providers/sprites";

describe("sprites provider container readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when createSprite returns status running", async () => {
    mockCreateSprite.mockResolvedValue({ name: "ca-sess-test", status: "running" });

    await spritesProvider.create({ name: "ca-sess-test" });

    expect(mockCreateSprite).toHaveBeenCalledTimes(1);
    expect(mockGetSprite).not.toHaveBeenCalled();
  });

  it("polls getSprite when createSprite returns status cold", async () => {
    mockCreateSprite.mockResolvedValue({ name: "ca-sess-test", status: "cold" });
    mockGetSprite
      .mockResolvedValueOnce({ name: "ca-sess-test", status: "cold" })
      .mockResolvedValueOnce({ name: "ca-sess-test", status: "cold" })
      .mockResolvedValueOnce({ name: "ca-sess-test", status: "running" });

    const createPromise = spritesProvider.create({ name: "ca-sess-test" });

    // Advance through the polling intervals
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await createPromise;

    expect(mockGetSprite).toHaveBeenCalledTimes(3);
    expect(mockGetSprite).toHaveBeenCalledWith("ca-sess-test", undefined);
  });

  it("polls getSprite when createSprite returns status warm", async () => {
    mockCreateSprite.mockResolvedValue({ name: "ca-sess-test", status: "warm" });
    mockGetSprite.mockResolvedValueOnce({ name: "ca-sess-test", status: "running" });

    const createPromise = spritesProvider.create({ name: "ca-sess-test" });
    await vi.advanceTimersByTimeAsync(500);
    await createPromise;

    expect(mockGetSprite).toHaveBeenCalledTimes(1);
  });

  it("times out when container never becomes running", async () => {
    // Use real timers — drive timeout by advancing Date.now() inside getSprite mock
    vi.useRealTimers();

    mockCreateSprite.mockResolvedValue({ name: "ca-sess-test", status: "cold" });

    let fakeNow = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    // Each getSprite call jumps time forward by 10s — after a few polls
    // the 30s deadline is exceeded and the loop exits.
    mockGetSprite.mockImplementation(async () => {
      fakeNow += 10_000;
      return { name: "ca-sess-test", status: "cold" };
    });

    await expect(
      spritesProvider.create({ name: "ca-sess-test" }),
    ).rejects.toThrow(/not ready after 30s/);

    // Should have polled at least once before timing out
    expect(mockGetSprite).toHaveBeenCalled();
    dateSpy.mockRestore();
  });

  it("passes tokenOverride through to getSprite calls", async () => {
    mockCreateSprite.mockResolvedValue({ name: "ca-sess-test", status: "cold" });
    mockGetSprite.mockResolvedValueOnce({ name: "ca-sess-test", status: "running" });

    const createPromise = spritesProvider.create({
      name: "ca-sess-test",
      secrets: { SPRITE_TOKEN: "custom-token" },
    });
    await vi.advanceTimersByTimeAsync(500);
    await createPromise;

    expect(mockCreateSprite).toHaveBeenCalledWith(
      expect.objectContaining({ tokenOverride: "custom-token" }),
    );
    // getSprite should also use the custom token
    expect(mockGetSprite).toHaveBeenCalledWith("ca-sess-test", "custom-token");
  });

  it("treats null getSprite response as not ready and keeps polling", async () => {
    mockCreateSprite.mockResolvedValue({ name: "ca-sess-test", status: "cold" });
    mockGetSprite
      .mockResolvedValueOnce(null) // sprite disappeared temporarily
      .mockResolvedValueOnce({ name: "ca-sess-test", status: "running" });

    const createPromise = spritesProvider.create({ name: "ca-sess-test" });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await createPromise;

    expect(mockGetSprite).toHaveBeenCalledTimes(2);
  });
});
