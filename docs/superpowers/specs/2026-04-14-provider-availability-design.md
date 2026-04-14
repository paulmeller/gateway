# Provider Availability System

## Context

The onboarding wizard lists all providers (docker, apple-container, podman, mvm, sprites, e2b, etc.) without checking if they're actually usable. Users select a provider, proceed through the wizard, and only discover it's not installed or not running when environment creation fails. Similarly, sessions in the sidebar give no indication when their provider has become unavailable (e.g. Docker stopped).

This design adds a provider status API and surfaces availability throughout the UI defensively.

## Backend — `GET /v1/providers/status`

New handler that checks all providers in parallel and returns availability + human-readable messages.

### Response shape

```json
{
  "data": {
    "docker": { "available": true },
    "apple-container": { "available": false, "message": "Apple Containers CLI not found. Run: brew install container (requires macOS 26+)" },
    "podman": { "available": false, "message": "Podman CLI is not installed. Install it from https://podman.io/docs/installation" },
    "mvm": { "available": false, "message": "mvm not ready. Run: mvm init && mvm serve install && mvm pool warm" },
    "sprites": { "available": false, "message": "Requires SPRITE_TOKEN — add it in Settings > Vaults" },
    "e2b": { "available": true },
    "vercel": { "available": false, "message": "Requires VERCEL_TOKEN — add it in Settings > Vaults" },
    "daytona": { "available": false, "message": "Requires DAYTONA_API_KEY — add it in Settings > Vaults" },
    "fly": { "available": false, "message": "Requires FLY_API_TOKEN — add it in Settings > Vaults" },
    "modal": { "available": false, "message": "Requires MODAL_TOKEN_ID — add it in Settings > Vaults" }
  }
}
```

### Check logic

**Local providers** (docker, apple-container, podman, mvm): Call existing `checkAvailability()` on each provider instance. These spawn the binary (e.g. `docker version`) and check daemon connectivity. Already return provider-specific messages distinguishing "not installed" from "not running".

**Cloud providers** (sprites, e2b, vercel, daytona, fly, modal): Check if the required API key exists in the settings DB or `process.env`. No network calls. Message format: "Requires {KEY_NAME} — add it in Settings > Vaults".

All checks run in parallel via `Promise.allSettled`. Response time ~100-200ms.

### Files

- Create: `packages/agent-sdk/src/handlers/providers.ts` — `handleGetProviderStatus()`
- Modify: `packages/agent-sdk/src/handlers/index.ts` — export new handler
- Modify: `packages/gateway-hono/src/index.ts` — register route

## Frontend — `useProviderStatus()` hook

New React Query hook in `hooks/use-providers.ts`:

```ts
useProviderStatus() → Record<string, { available: boolean; message?: string }>
```

- Fetches `GET /v1/providers/status` on mount
- Polls every 15s (`refetchInterval: 15_000`)
- Refetches on window focus (`refetchOnWindowFocus: true`)
- Multiple components consume the same cached query data

## Wizard Step 2 — Provider picker with availability

Replace the current flat `<Select>` dropdown with a styled list/radio group where each provider shows:

- **Available:** Normal text, selectable
- **Unavailable:** Greyed out, not selectable. Provider-specific message shown in small muted text underneath (e.g. "Docker not running — launch Docker Desktop", "Run: brew install container")

The list auto-updates as the 15s poll detects changes (user starts Docker → provider becomes selectable without page refresh).

Local and Cloud grouping is preserved.

### File

- Modify: `packages/gateway-ui/src/components/onboarding/StepEnvironment.tsx`

## Session sidebar — Unavailable provider indicator

Each `SessionItem` already looks up the environment via `useEnvironments()`. Cross-reference the environment's `config.provider` with `useProviderStatus()`:

- **Provider available:** Normal display (current behavior)
- **Provider unavailable:** Greyed out text (opacity-50), subtitle shows provider issue message

User can still click to view conversation history.

### File

- Modify: `packages/gateway-ui/src/components/sessions/SessionItem.tsx`

## Chat input — Disabled when provider unavailable

When viewing a session whose provider is unavailable, disable the message input and show a banner:

> "This session's provider (docker) is not available. Start Docker to continue."

The banner auto-dismisses when the 15s poll detects the provider is back.

### File

- Modify: `packages/gateway-ui/src/components/chat/ChatInput.tsx`

## No new dependencies. No DB changes.

## Verification

1. `GET /v1/providers/status` returns correct availability for all providers
2. Stop Docker → wizard shows "Docker not running" greyed out → start Docker → auto-enables within 15s
3. Session with docker environment shows greyed out in sidebar when Docker stopped
4. Chat input disabled with banner when provider unavailable
5. Cloud providers without API keys show "Requires {KEY}" message
6. All existing tests pass
