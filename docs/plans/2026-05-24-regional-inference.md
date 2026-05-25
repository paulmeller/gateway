# Regional Inference Routing

> Goal: Let users control where both sandbox execution AND LLM inference
> happen geographically — for GDPR compliance, latency optimization, and
> data residency requirements.

## Current state

**Sandbox region**: Already controllable via provider choice (Fly.io regions,
Docker on any host, sprites.dev, etc.).

**Inference region**: Not controllable. All backends hit a single global endpoint:
- Anthropic: `api.anthropic.com` (no region option)
- Google: `generativelanguage.googleapis.com` (global)
- OpenAI: `api.openai.com` (global)

## Regional endpoints available

| Provider | Regional option | Endpoint format |
|----------|----------------|-----------------|
| Google (Vertex AI) | Yes | `{region}-aiplatform.googleapis.com` |
| Anthropic (Bedrock) | Yes | AWS Bedrock regional endpoints |
| Anthropic (direct) | No | Single global endpoint |
| OpenAI (Azure) | Yes | Azure OpenAI regional deployments |
| OpenAI (direct) | No | Single global endpoint |

## Proposed API

Add optional `region` to environment config:

```json
{
  "name": "eu-environment",
  "config": {
    "provider": "fly",
    "provider_region": "lhr",
    "inference_region": "europe-west4"
  }
}
```

Or at the agent level:

```json
{
  "name": "gdpr-agent",
  "model": { "id": "gemini-2.5-flash" },
  "inference_endpoint": {
    "region": "europe-west4"
  }
}
```

## Implementation approach

### Phase 1: Google Vertex AI regional routing
- Add `inference_region` to environment or agent config
- When set + engine is gemini, switch from consumer API to Vertex AI endpoint
- Requires `GOOGLE_CLOUD_PROJECT` + Vertex AI credentials (different from `GEMINI_API_KEY`)
- The gemini CLI may already support `--project` and `--location` flags

### Phase 2: Anthropic via Bedrock
- When `inference_region` is set + engine is claude, route through AWS Bedrock
- Requires AWS credentials instead of `ANTHROPIC_API_KEY`
- Claude Code supports `--bedrock` flag with `AWS_REGION`

### Phase 3: OpenAI via Azure
- When `inference_region` is set + engine is codex, route through Azure OpenAI
- Requires Azure deployment URL + key

## Differentiator

Neither Anthropic nor Google offer region selection for managed agent
sandboxes on their hosted APIs. We offer both sandbox region (via provider)
AND inference region — full geographic control of the entire pipeline.

## Non-goals
- Per-request region override (too complex, session state would span regions)
- Multi-region failover (future)
- Region-aware model availability checks (future)
