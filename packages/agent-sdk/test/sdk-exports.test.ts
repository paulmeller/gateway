import { describe, it, expect } from "vitest";

describe("SDK exports", () => {
  it("exports createApiKey and listApiKeys", async () => {
    const sdk = await import("../src/index");
    expect(typeof sdk.createApiKey).toBe("function");
    expect(typeof sdk.listApiKeys).toBe("function");
  });

  it("exports ensureInitialized", async () => {
    const sdk = await import("../src/index");
    expect(typeof sdk.ensureInitialized).toBe("function");
  });

  it("exports getConfig", async () => {
    const sdk = await import("../src/index");
    expect(typeof sdk.getConfig).toBe("function");
  });

  it("exports writeSetting and invalidateConfigCache from config submodule", async () => {
    const config = await import("../src/config/index");
    expect(typeof config.getConfig).toBe("function");
    expect(typeof config.writeSetting).toBe("function");
    expect(typeof config.invalidateConfigCache).toBe("function");
  });

  it("exports handler functions", async () => {
    const handlers = await import("../src/handlers/index");
    expect(typeof handlers.handleCreateAgent).toBe("function");
    expect(typeof handlers.handleListAgents).toBe("function");
    expect(typeof handlers.handleCreateEnvironment).toBe("function");
    expect(typeof handlers.handleCreateSession).toBe("function");
    expect(typeof handlers.handlePostEvents).toBe("function");
    expect(typeof handlers.handleCreateVault).toBe("function");
    expect(typeof handlers.handleCreateMemoryStore).toBe("function");
    expect(typeof handlers.handleBatch).toBe("function");
    expect(typeof handlers.handlePutSetting).toBe("function");
    expect(typeof handlers.handleGetUI).toBe("function");
    expect(typeof handlers.handleSessionStream).toBe("function");
  });

  it("exports resolveContainerProvider", async () => {
    const sdk = await import("../src/index");
    expect(typeof sdk.resolveContainerProvider).toBe("function");
  });

  it("exports resolveBackend from backends registry", async () => {
    const registry = await import("../src/backends/registry");
    expect(typeof registry.resolveBackend).toBe("function");
  });
});

describe("Provider Registry", () => {
  it("resolves sprites provider", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    const provider = await resolveContainerProvider("sprites");
    expect(provider).toBeTruthy();
    expect(provider.name).toBe("sprites");
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.delete).toBe("function");
    expect(typeof provider.exec).toBe("function");
    expect(typeof provider.startExec).toBe("function");
  });

  it("resolves docker provider", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    const provider = await resolveContainerProvider("docker");
    expect(provider).toBeTruthy();
    expect(provider.name).toBe("docker");
  });

  it("resolves mvm provider (alias for apple-firecracker)", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    const provider = await resolveContainerProvider("mvm");
    expect(provider).toBeTruthy();
    // mvm is an alias — just verify the registry entry resolves to a valid provider object
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.startExec).toBe("function");
  });

  it("resolves apple-firecracker provider directly", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    const mvmProvider = await resolveContainerProvider("mvm");
    const afProvider = await resolveContainerProvider("apple-firecracker");
    // Both aliases should resolve to the same underlying provider object
    expect(mvmProvider.name).toBe(afProvider.name);
  });

  it("throws on unknown provider name", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    await expect(resolveContainerProvider("not-a-real-provider")).rejects.toThrow(
      /Unknown provider/,
    );
  });

  it("defaults to sprites when no provider name given", async () => {
    const { resolveContainerProvider } = await import("../src/providers/registry");
    const provider = await resolveContainerProvider(null);
    expect(provider.name).toBe("sprites");
  });
});
