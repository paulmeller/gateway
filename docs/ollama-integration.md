# Ollama Integration — Research Findings

## Status: Needs custom backend

Neither `opencode` nor `gemini` CLI support Ollama models:

- **opencode**: Validates model names against its internal registry. `openai/gemma4:latest` fails with `ProviderModelNotFoundError`. Setting `OPENAI_BASE_URL` is not enough.
- **gemini CLI**: Requires `GEMINI_API_KEY` and validates through Google's API even for `ollama/` prefixed models.

## Required: New `ollama` backend

A lightweight backend that calls Ollama's `/api/chat` endpoint directly (no CLI dependency). Ollama's API is simple:

```
POST http://localhost:11434/api/chat
{
  "model": "gemma4:latest",
  "messages": [{"role": "user", "content": "hello"}],
  "stream": true
}
```

Response is NDJSON with `{"message": {"role": "assistant", "content": "..."}}` chunks.

### Architecture

```
Gateway driver
  → buildTurn() returns { model, prompt }
  → No CLI spawn — direct HTTP to Ollama
  → Stream NDJSON response
  → Translator converts to Managed Agents events
```

### What's needed

1. `backends/ollama/index.ts` — backend implementation
2. `backends/ollama/translator.ts` — NDJSON → Managed Agents events
3. No wrapper script, no container exec — direct fetch to Ollama
4. Tool calling via Ollama's function calling API (if model supports it)

### Networking

- Docker: `http://host.docker.internal:11434`
- Apple Container: `http://host.containers.internal:11434`
- Cloud providers: Not supported (can't reach localhost)

### Complexity

Medium — ~300 LOC for the backend + translator. The Ollama API is simpler than the CLI NDJSON formats. But integrating with the gateway's driver (which expects `startExec()` → `ReadableStream`) requires either:
- Option A: Make the Ollama backend implement `startExec()` with a fake exec that does HTTP internally
- Option B: Add a new driver path that calls the model API directly without a container

Option A is simpler and fits the existing architecture.
