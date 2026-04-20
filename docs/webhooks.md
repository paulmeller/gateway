# Webhooks

Agents can POST events to an external URL as they happen. You set this
up per-agent via `webhook_url` + `webhook_events`. Optional signing
(v0.5+) lets receivers verify the POST came from your gateway and
hasn't been tampered with.

## Configuring a webhook

```http
POST /v1/agents
{
  "name": "ci-bot",
  "model": "claude-sonnet-4-6",
  "webhook_url": "https://example.com/hooks/agent-events",
  "webhook_events": [
    "session.status_idle",
    "session.status_running",
    "session.error"
  ],
  "webhook_secret": "replace-with-at-least-32-chars-of-entropy-please"
}
```

`webhook_secret` is optional. Without it, deliveries are unsigned
(matching pre-v0.5 behavior). When present, every delivery includes:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `User-Agent` | `agentstep-webhook/1` |
| `X-AgentStep-Timestamp` | Unix epoch ms when the request was built |
| `X-AgentStep-Signature` | `sha256=<hex(hmac_sha256(secret, ts + "." + body))>` |

The body is the same managed-event JSON that `/v1/sessions/:id/events`
would return.

## Verifying a signed webhook

The SDK ships a verifier:

```typescript
import { verifyWebhookSignature } from "@agentstep/agent-sdk";

// Inside your receiver:
const bodyText = await req.text();
const result = verifyWebhookSignature({
  secret: process.env.AGENTSTEP_WEBHOOK_SECRET!,
  body: bodyText,
  headers: req.headers,
});
if (!result.ok) {
  return new Response(`unauthorized: ${result.reason}`, { status: 401 });
}
const evt = JSON.parse(bodyText);
// ... process
```

The verifier is constant-time (`crypto.timingSafeEqual`), header
lookup is case-insensitive, and timestamps outside ±5 minutes of
server time are rejected (`toleranceMs` is configurable).

Manual verification without the SDK is straightforward — HMAC-SHA256
over `${timestamp}.${raw_body_bytes}`:

```bash
echo -n "${X_AGENTSTEP_TIMESTAMP}.$(cat body.json)" |
  openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex
```

Compare to the hex after `sha256=` in `X-AgentStep-Signature`.

## Rotating a secret

```http
PATCH /v1/agents/<agent_id>
{ "webhook_secret": "<new 32+ char secret>" }
```

or via CLI:

```bash
curl -X POST "$GATEWAY_URL/v1/agents/<agent_id>" \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"webhook_secret":"<new secret>"}'
```

**Rotation scope**: webhook signing is pinned to an **agent version**.
`PATCH /v1/agents/:id` creates a new agent version, so the new secret
applies to sessions created *after* the rotation. Sessions already in
progress keep signing with the secret they started with until they
close. If you rotate the verifier key on the receiver simultaneously,
in-flight webhook deliveries will start failing verification — rotate
receiver-side slightly *after* you're confident pre-rotation sessions
have drained.

To clear the secret (return to unsigned delivery):

```http
PATCH /v1/agents/<agent_id>
{ "webhook_secret": null }
```

## Delivery guarantees

Webhook delivery is **best-effort, fire-and-forget** with a 5 second
timeout. If your receiver returns non-2xx or times out, the delivery
is dropped silently. There is no retry queue in v0.5.

If you need durable delivery, subscribe to the SSE stream
(`/v1/sessions/:id/stream`) which is replay-safe via the
`last-event-id` header.
