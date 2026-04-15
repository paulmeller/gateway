---
name: setup-gateway
description: Interactive AgentStep Gateway setup — checks prerequisites, installs deps, configures secrets, starts server, runs first session
allowed-tools: Bash Read
---

You are guiding the user through a complete AgentStep Gateway setup. No docs needed — you are the installer. Run each step, check the output, troubleshoot errors, and don't move on until each step succeeds.

## Step 1: Check prerequisites

Run these and check the output:
- `node --version` — must be 22+. If missing or older, tell them to install from https://nodejs.org or run `brew install node`.
- `npm --version` — should come with Node. If missing, something is wrong with the Node install.

## Step 2: Install dependencies

```
npm install
```

If it fails:
- **EACCES**: Permission issue. Suggest `sudo chown -R $(whoami) ~/.npm` or using nvm.
- **Network errors**: Check internet connection, try `npm install --prefer-offline` if node_modules partially exists.

## Step 3: Build the UI and CLI

```
npm run build:ui
cd packages/gateway && node build.js
```

The first command builds the React UI (Vite → single HTML → ui.ts). The second bundles the CLI.

If it fails, check for TypeScript errors with `npm run typecheck`.

## Step 4: Start the server

```
node packages/gateway/dist/gateway.js serve &
```

Wait a few seconds, then verify it's running:
```
curl -s http://localhost:4000/api/health
```

The server auto-creates an API key on first run and writes it to `.env`. Check the console output for the key, or read it from `.env`:
```
cat .env | grep SEED_API_KEY
```

If it fails:
- **Port in use**: Check `lsof -i :4000` and suggest killing the process.
- **Database errors**: The SQLite DB auto-creates in `./data/`. Check directory permissions.

## Step 5: Secrets

This step is **blocking** — the user cannot proceed to chat without at least one backend key configured.

First, read the API key from `.env`:
```
source .env 2>/dev/null
echo "SEED_API_KEY: ${SEED_API_KEY:+set}"
```

Check if backend keys exist:
```
curl -s -H "x-api-key: $SEED_API_KEY" http://localhost:4000/api/health
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+set}"
echo "OPENAI_API_KEY: ${OPENAI_API_KEY:+set}"
echo "GEMINI_API_KEY: ${GEMINI_API_KEY:+set}"
```

**If NO keys exist**:
- Tell the user they must configure at least one API key to continue
- Recommend starting with Anthropic: "Paste your ANTHROPIC_API_KEY (get one at https://console.anthropic.com):"
- When the user provides a key, store it via the settings API:
  ```
  curl -s -X PUT -H "x-api-key: $SEED_API_KEY" -H "Content-Type: application/json" \
    -d '{"key":"anthropic_api_key","value":"<the-key>"}' \
    http://localhost:4000/v1/settings
  ```
- Alternatively, add to `.env`: `echo "ANTHROPIC_API_KEY=sk-..." >> .env` and restart the server.

Allowed settings keys: `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, `factory_api_key`, `claude_token`, `sprite_token`, `e2b_api_key`, `vercel_token`, `daytona_api_key`, `fly_api_token`, `modal_token_id`.

**Do NOT proceed past this step until at least one backend key is confirmed working.**

## Step 6: Run quickstart

This creates an agent + environment + session and starts an interactive chat:
```
node packages/gateway/dist/gateway.js quickstart
```

Available provider options:
- `--provider docker` — local Docker containers
- `--provider apple-container` — Apple Containers (macOS 26+)
- `--provider mvm` — Firecracker microVMs via mvm (macOS, requires `npm i -g @agentstep/mvm && mvm init`)
- `--provider sprites` — sprites.dev cloud (requires SPRITE_TOKEN)

If it works, the user should see an interactive chat session. Let them send a test message and verify they get a response.

If it fails:
- **No API key**: Go back to Step 5.
- **Provider errors**: Suggest `--provider docker` if Docker is running, or `--provider apple-container` on macOS 26+.

## Step 7: Done

Tell them:
- **Web UI**: http://localhost:4000 — chat interface with sidebar, settings, debug panel
- **Settings**: http://localhost:4000/settings — manage agents, environments, vaults, memory stores, batch
- **API docs**: http://localhost:4000/v1/docs — full OpenAPI documentation
- **CLI commands**:
  - `gateway agents list` — list agents
  - `gateway environments list` — list environments
  - `gateway sessions list` — list sessions
  - `gateway quickstart` — one-command setup for a new chat session
  - `gateway serve` — start the API server
- **Keyboard shortcuts**: Cmd+K for command palette in the web UI

## Troubleshooting

If something goes wrong at any point:
- Check server logs in the terminal where `gateway serve` is running
- Check the database: `ls -la ./data/`
- Reset everything: `rm -rf ./data/ .env && node packages/gateway/dist/gateway.js serve`
- Check API key: `curl -s -H "x-api-key: $(grep SEED_API_KEY .env | cut -d= -f2)" http://localhost:4000/v1/agents`
- Run tests: `npm test`
