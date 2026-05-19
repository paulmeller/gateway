# Provider Refactor — Move Provider from Environment to Executor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align environment config with Anthropic spec: `self_hosted` has no provider, `cloud` has no provider. Provider is a property of the executor (`gateway serve --provider` or `gateway worker --provider`), not the environment.

**Architecture:** The provider string moves from `environment.config.provider` to a process-level default set via CLI flag or env var. All execution pipeline functions accept provider as an injected parameter. Backward compat: if `config.provider` is set, it's used as a fallback (deprecated, logged warning).

**Tech Stack:** TypeScript, Zod, Commander.js, vitest

---

## What changes

### Before (provider on environment)
```json
POST /v1/environments
{ "config": { "type": "cloud", "provider": "docker" } }
```
Provider resolved at: `resolveContainerProvider(env.config.provider)` — 13 call sites.

### After (provider on executor)
```json
POST /v1/environments
{ "config": { "type": "self_hosted" } }
```
Provider resolved at startup: `gateway serve --provider docker` or `gateway worker --provider sprites`.

### The two environment types
```
type: "cloud"         → proxy to Anthropic (networking + packages config)
type: "self_hosted"   → local execution (no provider — executor decides)
```

---

## Touch points (26 total)

### SDK — execution pipeline (13 call sites)
| File | Lines | What |
|---|---|---|
| `driver.ts` | 260, 271, 496, 847, 1169, 1283 | Turn execution, re-entry, skill install |
| `driver.ts` | 373, 442 | Provider name check (codex firecracker detection) |
| `lifecycle.ts` | 214, 576, 802 | Container acquire, warm pool fill, release |
| `setup.ts` | 131 | Environment setup |
| `sweeper.ts` | 97 | Warm pool eviction |
| `init.ts` | 246, 362 | Pool rebuild on startup |

### SDK — validation (2 call sites)
| File | Lines | What |
|---|---|---|
| `environments.ts` | 125, 127 | Provider required on create |
| `sessions.ts` | 266, 312 | Anthropic provider compatibility check |

### CLI (3 call sites)
| File | Lines | What |
|---|---|---|
| `chat-loop.ts` | 39 | Chat command reads provider |
| `environments.ts` | CLI | `--provider` flag on env create |
| `quickstart.ts` | CLI | `--provider` flag on quickstart |

### UI (8 call sites)
| File | What |
|---|---|
| `ChatInput.tsx` | Reads provider for status display |
| `SessionItem.tsx` | Shows provider name |
| `PlaygroundPage.tsx` | Shows provider in session header |
| `EnvironmentsTab.tsx` | Shows provider in env list |
| `EnvironmentPopover.tsx` | Shows provider in popover |
| `StepEnvironment.tsx` | Filters by provider, shows in list |
| `use-environments.ts` | Creates env with provider |
| `OnboardingWizard.tsx` | Checks anthropic provider |

---

## Task 1: Process-level provider config

Add a process-level default provider that `gateway serve` and `gateway worker` set.

**Files:**
- Modify: `packages/agent-sdk/src/config/index.ts` — Add `defaultProvider` to config
- Modify: `packages/gateway/src/commands/serve.ts` — Add `--provider` flag
- Modify: `packages/gateway/src/commands/worker.ts` — Pass `--provider` to config

- [ ] **Step 1: Add to config**

In `packages/agent-sdk/src/config/index.ts`, add:
```typescript
defaultProvider: process.env.DEFAULT_PROVIDER || readSetting("default_provider") || undefined,
```

Add to the Config interface:
```typescript
defaultProvider?: string;
```

- [ ] **Step 2: Add `--provider` to gateway serve**

In `packages/gateway/src/commands/serve.ts`:
```typescript
.option("--provider <name>", "Default container provider (docker, sprites, mvm, etc.)")
```

In the action, set `process.env.DEFAULT_PROVIDER = opts.provider` before server starts.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: process-level default provider via --provider flag and DEFAULT_PROVIDER env var"
```

---

## Task 2: Provider resolver function

Create a single function that resolves provider with the right precedence: explicit param → env config (deprecated) → process default → auto-detect.

**Files:**
- Create: `packages/agent-sdk/src/providers/resolve.ts`

- [ ] **Step 1: Create resolver**

```typescript
import { resolveContainerProvider } from "./registry";
import { getConfig } from "../config";
import type { ContainerProvider } from "./types";

/**
 * Resolve a container provider with precedence:
 * 1. Explicit override (from worker CLI or function param)
 * 2. Environment config provider (deprecated — logs warning on first use)
 * 3. Process default (DEFAULT_PROVIDER env var or --provider flag)
 * 4. Error if none found
 */
let warnedEnvProvider = false;

export async function resolveProvider(opts?: {
  override?: string;
  envConfigProvider?: string;
}): Promise<ContainerProvider> {
  // 1. Explicit override
  if (opts?.override) {
    return resolveContainerProvider(opts.override);
  }

  // 2. Environment config (deprecated fallback)
  if (opts?.envConfigProvider) {
    if (!warnedEnvProvider) {
      console.warn("[provider] config.provider on environment is deprecated — use gateway serve --provider or gateway worker --provider instead");
      warnedEnvProvider = true;
    }
    return resolveContainerProvider(opts.envConfigProvider);
  }

  // 3. Process default
  const cfg = getConfig();
  if (cfg.defaultProvider) {
    return resolveContainerProvider(cfg.defaultProvider);
  }

  // 4. No provider found
  throw new Error(
    "No container provider configured. Set DEFAULT_PROVIDER env var, use gateway serve --provider <name>, or gateway worker --provider <name>."
  );
}

/** Get the provider name string with same precedence (for non-async contexts). */
export function resolveProviderName(opts?: {
  override?: string;
  envConfigProvider?: string;
}): string {
  if (opts?.override) return opts.override;
  if (opts?.envConfigProvider) return opts.envConfigProvider;
  const cfg = getConfig();
  if (cfg.defaultProvider) return cfg.defaultProvider;
  return "unknown";
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: provider resolver with precedence — override → env config (deprecated) → process default"
```

---

## Task 3: Update execution pipeline

Replace all 13 `resolveContainerProvider(env.config.provider)` calls with the new resolver.

**Files:**
- Modify: `packages/agent-sdk/src/sessions/driver.ts` — 8 call sites
- Modify: `packages/agent-sdk/src/containers/lifecycle.ts` — 3 call sites
- Modify: `packages/agent-sdk/src/containers/setup.ts` — 1 call site
- Modify: `packages/agent-sdk/src/sessions/sweeper.ts` — 1 call site
- Modify: `packages/agent-sdk/src/init.ts` — 2 call sites

- [ ] **Step 1: Update driver.ts**

Replace every:
```typescript
const provider = await resolveContainerProvider(env?.config?.provider);
```
With:
```typescript
const provider = await resolveProvider({ envConfigProvider: env?.config?.provider });
```

For the provider name checks (lines 373, 442):
```typescript
const provName = resolveProviderName({ envConfigProvider: envRow?.config?.provider });
```

Import `resolveProvider, resolveProviderName` from `"../providers/resolve"`.

- [ ] **Step 2: Update lifecycle.ts**

Same pattern for `acquireForFirstTurn()` (line 214), `fillOneEnv()` (line 576), `releaseSession()` (line 802).

- [ ] **Step 3: Update setup.ts, sweeper.ts, init.ts**

Same pattern — replace `resolveContainerProvider(config.provider)` with `resolveProvider({ envConfigProvider: config?.provider })`.

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git commit -m "refactor: execution pipeline uses provider resolver instead of direct env.config.provider"
```

---

## Task 4: Update environment validation

`self_hosted` environments no longer require `provider`. `cloud` environments don't accept it (they're Anthropic-hosted).

**Files:**
- Modify: `packages/agent-sdk/src/handlers/environments.ts`
- Modify: `packages/agent-sdk/src/handlers/sessions.ts`

- [ ] **Step 1: Update environment create validation**

In `environments.ts`, change the provider validation:

```typescript
// Before: provider is required
if (!parsed.data.config.provider) {
  throw badRequest("config.provider is required");
}

// After: provider is optional on self_hosted, forbidden on cloud
if (parsed.data.config.type === "cloud") {
  // Cloud = Anthropic proxy. No provider field.
  // Trigger sync-and-proxy flow.
} else if (parsed.data.config.type === "self_hosted") {
  // Provider is optional — executor (serve/worker) provides it.
  // If set, used as deprecated fallback.
}
```

- [ ] **Step 2: Update session create — anthropic detection**

In `sessions.ts`, the `config.provider === "anthropic"` check needs to change to `config.type === "cloud"`:

```typescript
// Before:
if (env.config?.provider === "anthropic") { /* proxy to Anthropic */ }

// After:
if (env.config?.type === "cloud") { /* proxy to Anthropic */ }
```

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git commit -m "refactor: self_hosted envs don't require provider; cloud triggers Anthropic proxy"
```

---

## Task 5: Update worker to pass provider through

The worker sets its provider and passes it through the execution chain.

**Files:**
- Modify: `packages/agent-sdk/src/workers/runner.ts`

- [ ] **Step 1: Worker sets process-level provider**

```typescript
export async function startWorker(opts: WorkerOptions): Promise<void> {
  // Set process-level provider from CLI flag
  if (opts.provider) {
    process.env.DEFAULT_PROVIDER = opts.provider;
  }
  // ... rest of worker loop
}
```

Now when `runTurn()` calls `resolveProvider()`, it falls through to the process default which the worker set. No need to thread provider through function params.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: worker sets DEFAULT_PROVIDER from --provider flag"
```

---

## Task 6: Update gateway serve with co-located worker

`gateway serve --provider docker` starts the API server and auto-processes `self_hosted` work items.

**Files:**
- Modify: `packages/gateway/src/commands/serve.ts`

- [ ] **Step 1: Add co-located worker to serve**

After the server starts, if `--provider` is set, start a co-located worker in the background:

```typescript
if (opts.provider) {
  process.env.DEFAULT_PROVIDER = opts.provider;
  
  // Auto-start a co-located worker for self_hosted environments
  const { startColocatedWorker } = await import("@agentstep/agent-sdk");
  void startColocatedWorker(); // polls all self_hosted envs
}
```

The co-located worker polls ALL self_hosted environments in the DB (no `--environment` needed since it's the same process/DB).

- [ ] **Step 2: Add `startColocatedWorker` to SDK**

In `packages/agent-sdk/src/workers/runner.ts`:

```typescript
/**
 * Start a co-located worker that polls ALL self_hosted environments.
 * Used by `gateway serve --provider <name>` for single-process deployments.
 */
export async function startColocatedWorker(): Promise<void> {
  // List all self_hosted environments
  // Poll each one on rotation
  // Same execute loop as startWorker
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: gateway serve --provider starts co-located worker for self_hosted envs"
```

---

## Task 7: Update CLI commands + UI

Update the CLI env create and quickstart commands. UI changes are cosmetic — show provider from process config or "self-hosted" label.

**Files:**
- Modify: `packages/gateway/src/commands/environments.ts` — `--provider` becomes optional, creates `self_hosted` type
- Modify: `packages/gateway/src/commands/quickstart.ts` — Creates `self_hosted` env, uses `--provider` for serve default
- Modify: `packages/gateway-ui/src/hooks/use-environments.ts` — Create env with `self_hosted` type
- Modify: UI components — Show "self_hosted" or provider from session/runtime info

- [ ] **Step 1: Update CLI env create**

```typescript
// Before: creates cloud env with required provider
// After: creates self_hosted env, provider optional hint
agents.command("create")
  .option("--provider <name>", "Provider hint (deprecated — use gateway serve --provider)")
  .action(async (opts) => {
    const config: any = { type: "self_hosted" };
    if (opts.provider) config.provider = opts.provider; // deprecated fallback
    // ...
  });
```

- [ ] **Step 2: Update quickstart**

The quickstart wizard creates a `self_hosted` environment. The provider selection step sets `DEFAULT_PROVIDER` for the serve process instead of putting it on the env config.

- [ ] **Step 3: Update UI create environment**

Change `type: "cloud"` to `type: "self_hosted"` in the environment creation hook.

- [ ] **Step 4: Update UI display components**

UI components that show `env.config.provider` should fall back to "self-hosted" when not set. The provider info can come from the session's runtime (if tracked) or just show the environment type.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: CLI and UI use self_hosted environment type"
```

---

## Task 8: Update tests + backward compat

- [ ] **Step 1: Update test fixtures**

All tests that create environments with `type: "cloud", provider: "docker"` need to change to `type: "self_hosted"`. Set `DEFAULT_PROVIDER=docker` in test setup.

- [ ] **Step 2: Backward compat layer**

In the environment handler, if `type: "cloud"` is sent with a non-anthropic provider:
- Accept it silently (no error)
- Internally treat as `self_hosted`
- Log deprecation warning

```typescript
// In environment create handler:
let configType = parsed.data.config.type;
if (configType === "cloud" && parsed.data.config.provider && parsed.data.config.provider !== "anthropic") {
  console.warn(`[compat] type: "cloud" with provider "${parsed.data.config.provider}" is deprecated — use type: "self_hosted"`);
  configType = "self_hosted";
}
```

- [ ] **Step 3: Run full test suite and commit**

```bash
npx vitest run
git commit -m "refactor: backward compat for cloud→self_hosted + update all test fixtures"
```

---

## Delivery order

1. **Task 1** — Process-level provider config (~30 min)
2. **Task 2** — Provider resolver function (~30 min)
3. **Task 3** — Update 13 execution pipeline call sites (~1 hr)
4. **Task 4** — Environment validation changes (~30 min)
5. **Task 5** — Worker passes provider through (~15 min)
6. **Task 6** — Serve with co-located worker (~1 hr)
7. **Task 7** — CLI + UI updates (~1 hr)
8. **Task 8** — Tests + backward compat (~1 hr)

Total: ~6 hours

## What this unlocks

- `self_hosted` environments match Anthropic spec exactly
- Same environment, different workers with different providers
- `gateway serve --provider docker` is the single-process default (zero config change for most users)
- `gateway worker --provider sprites` for separate execution processes
- `cloud` type reserved for Anthropic proxy only
- Future: auto-detect provider if `--provider` not specified
