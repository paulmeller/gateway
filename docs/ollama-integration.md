# Ollama Integration

Run local LLMs via [Ollama](https://ollama.com) through AgentStep Gateway.
Ollama models work with the **Codex** and **OpenCode** engines — no API
keys required.

## Quick start

```bash
# 1. Install and start Ollama
brew install ollama
OLLAMA_HOST=0.0.0.0:11434 ollama serve

# 2. Pull a model
ollama pull qwen3:8b

# 3. Create an agent with a local model
gateway agents create --name local-bot --engine codex --model qwen3:8b

# 4. Create an environment (any container provider)
gateway environments create --name dev --provider docker

# 5. Start a session
gateway sessions create --agent <agent-id> --environment <env-id>
gateway chat <session-id>
```

## Supported engines

| Engine | How it works | Notes |
|--------|-------------|-------|
| **Codex** | `codex exec --oss --local-provider ollama` | Model must support tool calling |
| **OpenCode** | `OPENCODE_CONFIG_CONTENT` with `@ai-sdk/openai-compatible` provider | Any chat model works |

Models that **don't** support tool calling (e.g. some older Ollama builds
of gemma4) will fail on Codex with "does not support tools". Use OpenCode
for those, or upgrade Ollama to v0.20.0+ where gemma4 tool support was
added.

## Model detection

The gateway auto-detects Ollama models by exclusion: any model name that
doesn't contain `/` and doesn't start with a known cloud prefix
(`claude-`, `gpt-`, `o1-`, `o3-`, `o4-`, `codex-`, `chatgpt-`, `gemini-`)
is treated as a local Ollama model.

Examples:
- `qwen3:8b` → Ollama
- `gemma4:latest` → Ollama
- `llama3.3:70b` → Ollama
- `claude-sonnet-4-6` → Cloud (Anthropic)
- `anthropic/claude-sonnet-4-6` → Cloud (prefixed)

## Container networking

Ollama runs on the **host** machine. Containers need to reach it across
the network boundary. The gateway automatically injects the right
connection env vars based on the container provider:

| Provider | Host address | Env vars set |
|----------|-------------|-------------|
| **Docker / Podman** | `host.docker.internal:11434` | `OLLAMA_HOST`, `CODEX_OSS_BASE_URL` |
| **Apple Container / Firecracker** | `192.168.64.1:11434` | `OLLAMA_HOST`, `CODEX_OSS_BASE_URL` |
| **Local (no container)** | `localhost:11434` | None needed |

### Apple Container setup

Apple Container VMs can't reach `localhost`. You must start Ollama
listening on all interfaces:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Or via brew services, create a plist override that sets the env var.

### Custom Ollama URL

If Ollama runs on a non-default address, configure it via:

```bash
# Environment variable
export OLLAMA_URL=http://10.0.0.5:11434

# Or via settings API
curl -X PUT http://localhost:4000/v1/settings \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ollama_url": "http://10.0.0.5:11434"}'
```

## Environment variables injected

When an Ollama model is detected, the gateway injects these env vars
into the container:

| Env var | Used by | Format | Example |
|---------|---------|--------|---------|
| `OLLAMA_HOST` | Ollama CLI | `host:port` | `host.docker.internal:11434` |
| `CODEX_OSS_BASE_URL` | Codex `--local-provider ollama` | `http://host:port/v1` | `http://host.docker.internal:11434/v1` |
| `OPENCODE_CONFIG_CONTENT` | OpenCode config | JSON with `provider.ollama.options.baseURL` | (patched automatically) |
| `OPENAI_API_KEY` | Codex startup | `"ollama"` (dummy, required by Codex) | `ollama` |
| `CODEX_API_KEY` | Codex startup | `"ollama"` (dummy) | `ollama` |

No real API keys are needed — the dummy values prevent Codex from
erroring on startup.

## Model registry

The gateway's dynamic model registry auto-discovers Ollama models from
the local server (`GET /api/tags`). These appear in the UI's model
dropdown tagged with `codex` and `opencode` engine compatibility.

If Ollama isn't running, the registry gracefully skips it and shows
only cloud models.

## Ollama version requirements

| Feature | Minimum version |
|---------|----------------|
| Basic chat | Any |
| Tool calling (qwen3, llama3.3, etc.) | v0.3.0+ |
| Tool calling (gemma4) | v0.20.0+ |
| Stable gemma4 tool parsing | v0.20.6+ |

Check your running server version:

```bash
curl http://localhost:11434/api/version
```

**Common gotcha:** `ollama --version` shows the CLI version, but the
server may be an older process. Restart the server after upgrading:

```bash
brew services restart ollama
# or: pkill ollama && ollama serve
```

## Limitations

- **Cloud providers** (E2B, Vercel, Fly, Modal, Cloud Run) cannot reach
  a local Ollama server. Use cloud-hosted models with those providers.
- **No vault key needed**, but Codex still requires dummy `OPENAI_API_KEY`
  and `CODEX_API_KEY` values (injected automatically).
- **Token usage** is not reported by Ollama's OpenAI-compatible API, so
  session usage stats will show zeros for Ollama models.

## Source

- Model detection: [`backends/models.ts`](../packages/agent-sdk/src/backends/models.ts) (`isValidModelForEngine`)
- Codex args: [`backends/codex/args.ts`](../packages/agent-sdk/src/backends/codex/args.ts) (`--oss --local-provider ollama`)
- OpenCode config: [`backends/opencode/mcp.ts`](../packages/agent-sdk/src/backends/opencode/mcp.ts) (`buildOpencodeConfigEnv`)
- Container networking: [`sessions/driver.ts`](../packages/agent-sdk/src/sessions/driver.ts) (OLLAMA_HOST / CODEX_OSS_BASE_URL injection)
- Model registry: [`lib/model-registry.ts`](../packages/agent-sdk/src/lib/model-registry.ts) (Ollama source)
