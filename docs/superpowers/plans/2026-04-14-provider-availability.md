# Provider Availability System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider status API and surface provider availability throughout the UI — greying out unavailable providers in the wizard, dimming sessions with unavailable providers, and disabling chat input when a session's provider is down.

**Architecture:** New `GET /v1/providers/status` handler checks all providers in parallel (local: spawn binary; cloud: check API key in settings/env). Frontend `useProviderStatus()` hook polls every 15s. Three UI surfaces consume the data: wizard StepEnvironment, SessionItem sidebar, and ChatInput.

**Tech Stack:** TypeScript, agent-sdk handlers, React Query, shadcn/ui

---

## File Structure

```
packages/agent-sdk/src/
  handlers/providers.ts          — CREATE: handleGetProviderStatus()
  handlers/index.ts              — MODIFY: export new handler
  providers/resolve-secrets.ts   — READ: cloud key checking pattern
packages/gateway-hono/src/
  index.ts                       — MODIFY: register GET /v1/providers/status
packages/gateway-ui/src/
  hooks/use-providers.ts                      — CREATE: useProviderStatus() hook
  components/onboarding/StepEnvironment.tsx   — MODIFY: provider picker with availability
  components/sessions/SessionItem.tsx         — MODIFY: grey out unavailable sessions
  components/chat/ChatInput.tsx               — MODIFY: disable when provider unavailable
packages/agent-sdk/test/
  api-comprehensive.test.ts      — MODIFY: add provider status tests
```

---

### Task 1: Create `handleGetProviderStatus` handler

**Files:**
- Create: `packages/agent-sdk/src/handlers/providers.ts`
- Modify: `packages/agent-sdk/src/handlers/index.ts`

- [ ] **Step 1: Create the handler file**

```ts
// packages/agent-sdk/src/handlers/providers.ts
import { routeWrap, jsonOk } from "../http";
import { resolveContainerProvider } from "../providers/registry";
import { getConfig } from "../config/index";
import type { AvailabilityResult, ProviderName } from "../providers/types";

const LOCAL_PROVIDERS: ProviderName[] = ["docker", "apple-container", "podman", "mvm"];
const CLOUD_PROVIDERS: ProviderName[] = ["sprites", "e2b", "vercel", "daytona", "fly", "modal"];

/** env var required for each cloud provider */
const CLOUD_KEY_MAP: Record<string, string> = {
  sprites: "SPRITE_TOKEN",
  e2b: "E2B_API_KEY",
  vercel: "VERCEL_TOKEN",
  daytona: "DAYTONA_API_KEY",
  fly: "FLY_API_TOKEN",
  modal: "MODAL_TOKEN_ID",
};

async function checkLocalProvider(name: ProviderName): Promise<AvailabilityResult> {
  try {
    const provider = await resolveContainerProvider(name);
    if (provider.checkAvailability) {
      return await provider.checkAvailability();
    }
    return { available: true };
  } catch {
    return { available: false, message: `Provider "${name}" could not be loaded` };
  }
}

function checkCloudProvider(name: string): AvailabilityResult {
  const envVar = CLOUD_KEY_MAP[name];
  if (!envVar) return { available: true };

  // Check process.env
  if (process.env[envVar]) return { available: true };

  // Check settings DB via config (sprites is the only cloud provider in config cascade)
  if (name === "sprites") {
    const config = getConfig();
    if (config.spriteToken) return { available: true };
  }

  return {
    available: false,
    message: `Requires ${envVar} — add it in Settings > Vaults`,
  };
}

export async function handleGetProviderStatus(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const results: Record<string, AvailabilityResult> = {};

    // Check all providers in parallel
    const localChecks = LOCAL_PROVIDERS.map(async (name) => {
      results[name] = await checkLocalProvider(name);
    });

    // Cloud checks are synchronous
    for (const name of CLOUD_PROVIDERS) {
      results[name] = checkCloudProvider(name);
    }

    await Promise.allSettled(localChecks);

    return jsonOk({ data: results });
  });
}
```

- [ ] **Step 2: Export from handlers/index.ts**

Add this line to `packages/agent-sdk/src/handlers/index.ts`:

```ts
export { handleGetProviderStatus } from "./providers";
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/src/handlers/providers.ts packages/agent-sdk/src/handlers/index.ts
git commit -m "feat: add GET /v1/providers/status handler"
```

---

### Task 2: Register route in gateway-hono

**Files:**
- Modify: `packages/gateway-hono/src/index.ts`

- [ ] **Step 1: Import and register the route**

In `packages/gateway-hono/src/index.ts`, add `handleGetProviderStatus` to the import:

```ts
import {
  // ... existing imports ...
  handleGetProviderStatus,
} from "@agentstep/agent-sdk/handlers";
```

After the `// ── Settings ──` section, add:

```ts
// ── Providers ─────────────────────────────────────────────────────────
app.get("/v1/providers/status", (c) => handleGetProviderStatus(c.req.raw));
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway-hono/src/index.ts
git commit -m "feat: register GET /v1/providers/status route"
```

---

### Task 3: Add provider status tests

**Files:**
- Modify: `packages/agent-sdk/test/api-comprehensive.test.ts`

- [ ] **Step 1: Add test block**

Add at the end of the test file, before the closing `});` of the outer describe:

```ts
describe("Provider Status", () => {
  it("returns status for all providers", async () => {
    const { handleGetProviderStatus } = await import("../src/handlers/providers");
    const res = await handleGetProviderStatus(req("/v1/providers/status"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, { available: boolean; message?: string }> };
    expect(body.data).toBeDefined();
    // Should have entries for local and cloud providers
    expect(body.data.docker).toBeDefined();
    expect(body.data["apple-container"]).toBeDefined();
    expect(body.data.podman).toBeDefined();
    expect(body.data.mvm).toBeDefined();
    expect(body.data.sprites).toBeDefined();
    expect(body.data.e2b).toBeDefined();
    expect(body.data.vercel).toBeDefined();
    expect(body.data.daytona).toBeDefined();
    expect(body.data.fly).toBeDefined();
    expect(body.data.modal).toBeDefined();
    // Each entry has available boolean
    for (const [, status] of Object.entries(body.data)) {
      expect(typeof status.available).toBe("boolean");
      if (!status.available) {
        expect(typeof status.message).toBe("string");
      }
    }
  });

  it("cloud providers without keys report unavailable", async () => {
    // Clear cloud provider env vars
    const saved = { ...process.env };
    delete process.env.SPRITE_TOKEN;
    delete process.env.E2B_API_KEY;
    delete process.env.VERCEL_TOKEN;
    // Clear config cache
    const g = globalThis as typeof globalThis & { __caConfigCache?: unknown };
    delete g.__caConfigCache;
    try {
      const { handleGetProviderStatus } = await import("../src/handlers/providers");
      const res = await handleGetProviderStatus(req("/v1/providers/status"));
      const body = await res.json() as { data: Record<string, { available: boolean; message?: string }> };
      expect(body.data.sprites.available).toBe(false);
      expect(body.data.sprites.message).toContain("SPRITE_TOKEN");
      expect(body.data.e2b.available).toBe(false);
      expect(body.data.e2b.message).toContain("E2B_API_KEY");
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("requires auth", async () => {
    const { handleGetProviderStatus } = await import("../src/handlers/providers");
    const res = await handleGetProviderStatus(req("/v1/providers/status", { apiKey: "" }));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
```

Expected: All pass (local providers will show unavailable in CI which is correct).

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/test/api-comprehensive.test.ts
git commit -m "test: add provider status endpoint tests"
```

---

### Task 4: Create `useProviderStatus()` hook

**Files:**
- Create: `packages/gateway-ui/src/hooks/use-providers.ts`

- [ ] **Step 1: Create the hook**

```ts
// packages/gateway-ui/src/hooks/use-providers.ts
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface ProviderStatus {
  available: boolean;
  message?: string;
}

interface ProviderStatusResponse {
  data: Record<string, ProviderStatus>;
}

export function useProviderStatus() {
  return useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api<ProviderStatusResponse>("/providers/status"),
    select: (d) => d.data,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway-ui/src/hooks/use-providers.ts
git commit -m "feat(gateway-ui): add useProviderStatus() hook with 15s polling"
```

---

### Task 5: Update StepEnvironment with provider availability

**Files:**
- Modify: `packages/gateway-ui/src/components/onboarding/StepEnvironment.tsx`

- [ ] **Step 1: Replace the provider Select with an availability-aware list**

Replace the entire content of `StepEnvironment.tsx` with:

```tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LOCAL_PROVIDERS, CLOUD_PROVIDERS } from "@/lib/constants";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus } from "@/hooks/use-providers";

type EnvResult =
  | { mode: "create"; data: { name: string; provider: string } }
  | { mode: "select"; env: { id: string; name: string; provider: string } };

interface Props { onNext: (result: EnvResult) => void; }

export function StepEnvironment({ onNext }: Props) {
  const { data: envs, isLoading } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();
  const readyEnvs = envs?.filter(e => e.state === "ready") ?? [];
  const hasExisting = !isLoading && readyEnvs.length > 0;
  const [mode, setMode] = useState<"select" | "create">("create");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("dev");
  const [provider, setProvider] = useState("");

  useEffect(() => {
    if (!isLoading) setMode(hasExisting ? "select" : "create");
  }, [isLoading, hasExisting]);

  // Auto-select first available provider
  useEffect(() => {
    if (providerStatus && !provider) {
      const allProviders = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS];
      const first = allProviders.find(p => providerStatus[p]?.available);
      if (first) setProvider(first);
    }
  }, [providerStatus, provider]);

  function handleSelectContinue() {
    const env = readyEnvs.find(e => e.id === selectedId);
    if (!env) return;
    onNext({ mode: "select", env: { id: env.id, name: env.name, provider: env.config?.provider || "sprites" } });
  }

  function handleCreate() {
    if (!name.trim() || !provider) return;
    onNext({ mode: "create", data: { name: name.trim(), provider } });
  }

  if (isLoading) return null;

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 2 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Choose an Environment</h2>
        <p className="text-sm text-muted-foreground mt-1">Select an existing environment or create a new one.</p>
      </div>

      {hasExisting && (
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "select" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("select")}
          >
            Use existing
          </button>
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "create" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("create")}
          >
            Create new
          </button>
        </div>
      )}

      {mode === "select" && hasExisting && (
        <div className="flex flex-col gap-3">
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="h-10 w-full text-foreground"><SelectValue placeholder="Select an environment" /></SelectTrigger>
            <SelectContent>
              {readyEnvs.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name} <span className="text-muted-foreground ml-1">({e.config?.provider || "sprites"})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleSelectContinue} disabled={!selectedId}>
            Continue
          </Button>
        </div>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-3">
          <Input placeholder="Environment name" value={name} onChange={(e) => setName(e.target.value)}
            className="h-10 w-full text-foreground" />

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Local</p>
            <div className="flex flex-col gap-1">
              {LOCAL_PROVIDERS.map((p) => {
                const status = providerStatus?.[p];
                const available = status?.available ?? true;
                const isSelected = provider === p;
                return (
                  <button
                    key={p}
                    disabled={!available}
                    onClick={() => available && setProvider(p)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-lime-400/50 bg-lime-400/10"
                        : available
                          ? "border-border hover:border-muted-foreground/50"
                          : "border-border opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <span className={`text-sm font-medium ${isSelected ? "text-foreground" : available ? "text-foreground" : "text-muted-foreground"}`}>
                      {p}
                    </span>
                    {!available && status?.message && (
                      <span className="text-xs text-muted-foreground mt-0.5">{status.message}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Cloud</p>
            <div className="flex flex-col gap-1">
              {CLOUD_PROVIDERS.map((p) => {
                const status = providerStatus?.[p];
                const available = status?.available ?? true;
                const isSelected = provider === p;
                return (
                  <button
                    key={p}
                    disabled={!available}
                    onClick={() => available && setProvider(p)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-lime-400/50 bg-lime-400/10"
                        : available
                          ? "border-border hover:border-muted-foreground/50"
                          : "border-border opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <span className={`text-sm font-medium ${isSelected ? "text-foreground" : available ? "text-foreground" : "text-muted-foreground"}`}>
                      {p}
                    </span>
                    {!available && status?.message && (
                      <span className="text-xs text-muted-foreground mt-0.5">{status.message}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || !provider}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway-ui/src/components/onboarding/StepEnvironment.tsx
git commit -m "feat(gateway-ui): show provider availability in wizard Step 2"
```

---

### Task 6: Update SessionItem with provider availability

**Files:**
- Modify: `packages/gateway-ui/src/components/sessions/SessionItem.tsx`

- [ ] **Step 1: Add provider status to SessionItem**

Replace the entire content of `SessionItem.tsx` with:

```tsx
import { X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useArchiveSession } from "@/hooks/use-sessions";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus } from "@/hooks/use-providers";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  session: {
    id: string;
    status: string;
    title: string | null;
    created_at: number;
    archived_at: number | null;
    agent?: { id: string };
    environment_id?: string;
  };
}

export function SessionItem({ session }: Props) {
  const { activeSessionId, setActiveSessionId } = useAppStore();
  const archive = useArchiveSession();
  const isActive = activeSessionId === session.id;
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();

  const agent = agents?.find((a) => a.id === session.agent?.id);
  const env = environments?.find((e) => e.id === session.environment_id);
  const providerName = env?.config?.provider || "sprites";
  const status = providerStatus?.[providerName];
  const providerAvailable = status?.available ?? true;

  const subtitle = [agent?.name, providerName].filter(Boolean).join(" · ");

  const item = (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={() => setActiveSessionId(session.id)}
        className={`text-xs h-auto py-1.5 ${!providerAvailable ? "opacity-50" : ""}`}
      >
        <div className="flex flex-col items-start gap-0.5 min-w-0">
          <div className="flex items-center gap-1.5 w-full">
            {session.status === "running" && providerAvailable && (
              <div className="size-1.5 shrink-0 rounded-full bg-lime-400 shadow-[0_0_6px_oklch(0.84_0.18_128/0.5)]" />
            )}
            {!providerAvailable && (
              <div className="size-1.5 shrink-0 rounded-full bg-destructive" />
            )}
            <span className="truncate">{session.title || session.id.slice(0, 12)}</span>
          </div>
          {subtitle && (
            <span className="text-[10px] text-muted-foreground truncate w-full">
              {subtitle}
            </span>
          )}
        </div>
      </SidebarMenuButton>
      {!session.archived_at && (
        <SidebarMenuAction onClick={() => archive.mutate(session.id)}>
          <X className="size-3" />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );

  if (!providerAvailable && status?.message) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <p className="text-xs">{status.message}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return item;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway-ui/src/components/sessions/SessionItem.tsx
git commit -m "feat(gateway-ui): grey out sessions with unavailable providers"
```

---

### Task 7: Disable ChatInput when provider unavailable

**Files:**
- Modify: `packages/gateway-ui/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: Add provider check to ChatInput**

Replace the entire content of `ChatInput.tsx` with:

```tsx
import { useRef, useState } from "react";
import { ArrowUp, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-sessions";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus } from "@/hooks/use-providers";

export function ChatInput() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  const { data: session } = useSession(sessionId);
  const { data: environments } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();

  const env = environments?.find((e) => e.id === session?.environment_id);
  const providerName = env?.config?.provider || "sprites";
  const status = providerStatus?.[providerName];
  const providerAvailable = status?.available ?? true;

  async function handleSend() {
    if (!sessionId || !text.trim() || sending || !providerAvailable) return;
    const msg = text.trim();
    setText("");
    setSending(true);
    try {
      await api(`/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: msg }] }] }),
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  if (!sessionId) return null;

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 py-3">
      {!providerAvailable && status?.message && (
        <div className="mx-auto max-w-3xl mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{status.message}</p>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={providerAvailable ? "Message..." : "Provider unavailable"}
          disabled={!providerAvailable}
          className="min-h-[44px] max-h-[200px] resize-none border-border bg-muted text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-ring disabled:opacity-50"
          rows={1}
        />
        <Button
          size="icon"
          className="size-[44px] shrink-0 bg-cta-gradient text-black hover:opacity-90 disabled:opacity-30"
          onClick={handleSend}
          disabled={!text.trim() || sending || !providerAvailable}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway-ui/src/components/chat/ChatInput.tsx
git commit -m "feat(gateway-ui): disable chat input when provider unavailable"
```

---

### Task 8: Build, verify, and commit

- [ ] **Step 1: Run tests**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
```

Expected: All tests pass including the new provider status tests.

- [ ] **Step 2: Build UI**

```bash
cd packages/gateway-ui && npx vite build
```

Expected: Clean build, no TypeScript errors.

- [ ] **Step 3: Build full pipeline**

```bash
cd /Users/paulmeller/Projects/managed-agents && npx tsx scripts/build-ui.ts
cd packages/gateway && node build.js
```

- [ ] **Step 4: Manual verification**

Start: `node packages/gateway/dist/gateway.js serve --port 4111`

Verify:
1. `curl -H "x-api-key: <key>" http://localhost:4111/v1/providers/status` → returns all providers with availability
2. Open http://localhost:4111 → wizard Step 2 shows providers with availability status
3. Unavailable providers are greyed out with message text
4. Sessions with unavailable providers show dimmed in sidebar with red dot
5. Hovering a dimmed session shows tooltip with provider message
6. Opening a session with unavailable provider shows warning banner above input
7. Chat input is disabled for sessions with unavailable providers
8. Start Docker (if available) → within 15s, provider auto-enables everywhere

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: provider availability system — status API + wizard + sidebar + chat input"
```

---

## Verification

1. `GET /v1/providers/status` returns correct availability for all providers
2. Stop Docker → wizard greys it out with message → start Docker → auto-enables within 15s
3. Session sidebar greys out sessions with unavailable providers, tooltip shows message
4. Chat input disabled with warning banner when provider unavailable
5. Cloud providers without API keys show "Requires {KEY}" message
6. All existing tests pass + new provider status tests pass
