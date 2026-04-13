---
name: setup-gateway
description: Interactive AgentStep Gateway setup — checks prerequisites, installs deps, configures secrets, starts server, runs first session
allowed-tools: Bash Read
---

You are guiding the user through a complete AgentStep Gateway setup. No docs needed — you are the installer. Run each step, check the output, troubleshoot errors, and don't move on until each step succeeds.

## Step 1: Check prerequisites

Run these and check the output:
- `node --version` — must be 18+. If missing or older, tell them to install from https://nodejs.org or run `brew install node`.
- `npm --version` — should come with Node. If missing, something is wrong with the Node install.

## Step 2: Install dependencies

```
npm install
```

If it fails:
- **EACCES**: Permission issue. Suggest `sudo chown -R $(whoami) ~/.npm` or using nvm.
- **Network errors**: Check internet connection, try `npm install --prefer-offline` if node_modules partially exists.

## Step 3: Start the server

```
npm run dev &
```

Wait a few seconds, then verify it's running:
```
curl -s http://localhost:4000/api/health
```

If it fails:
- **Port in use**: Check `lsof -i :4000` and suggest killing the process or using a different port.
- **Database errors**: The SQLite DB auto-creates in `./data/`. Check directory permissions.

## Step 4: Secrets

This step is **blocking** — the user cannot proceed to chat without at least one backend key configured.

First, check if the server already has keys configured (via env vars or the settings DB):
```
curl -s http://localhost:4000/api/health 2>/dev/null && echo ""
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+set}"
echo "OPENAI_API_KEY: ${OPENAI_API_KEY:+set}"
echo "GEMINI_API_KEY: ${GEMINI_API_KEY:+set}"
```

Also check the settings table for server-side keys:
```
sqlite3 data/managed-agents.db "SELECT key FROM settings WHERE key IN ('anthropic_api_key','openai_api_key','gemini_api_key') AND value != ''" 2>/dev/null
```

**If at least one key exists** (either as env var or in settings DB):
- Tell the user which backends are available
- Ask if they want to add or override any keys (optional — they can skip)

**If NO keys exist anywhere**:
- Tell the user they must configure at least one API key to continue
- Recommend starting with Anthropic: "Paste your ANTHROPIC_API_KEY (get one at https://console.anthropic.com):"
- When the user provides a key, store it in the settings DB so it persists across restarts:
  ```
  sqlite3 data/managed-agents.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('anthropic_api_key', '<the-key>')"
  ```
- Optionally ask if they also want to add OpenAI or Gemini keys

Keys can be stored via:
- **Settings DB** (persists): `sqlite3 data/managed-agents.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('<key_name>', '<value>')"`
- **Environment variable** (session only): `export ANTHROPIC_API_KEY=...`
- **`.env` file** (persists, loaded by server): add to `.env` in project root

The settings DB keys are: `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, `factory_api_key`, `claude_token`.

After storing, invalidate the config cache by restarting the server or waiting 30 seconds.

**Do NOT proceed past this step until at least one backend key is confirmed working.**

## Step 5: Build and typecheck

```
npm run build -w @agentstep/agent-sdk 2>&1 | tail -5
```

If it fails, check for TypeScript errors and help fix them.

## Step 6: Run quickstart

This creates an agent + environment + session and starts an interactive chat:
```
npx @agentstep/gateway quickstart
```

If it works, the user should see an interactive chat session. Let them send a test message and verify they get a response.

If it fails:
- **No API key**: Go back to Step 4.
- **Sprite/provider errors**: Suggest using `--provider docker` if they have Docker installed, or check that the default provider is configured.

## Step 7: Done

Tell them:
- **Server UI**: http://localhost:4000 — web dashboard for managing agents and sessions
- **API docs**: http://localhost:4000/v1/docs — full OpenAPI documentation
- **CLI commands**:
  - `gateway agents create --name mybot --model claude-sonnet-4-20250514` — create an agent
  - `gateway environments create --name dev` — create an environment
  - `gateway sessions create --agent <id> --environment <id>` — start a session
  - `gateway quickstart` — one-command setup for a new chat session
  - `gateway serve` — start the API server
- **Secrets**: keys are stored in the settings DB. Add more via:
  - `sqlite3 data/managed-agents.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('openai_api_key', 'sk-...')"`
  - Or set env vars / add to `.env`

## Troubleshooting

If something goes wrong at any point:
- Check server logs in the terminal where `npm run dev` is running
- Check the database: `ls -la ./data/`
- Reset everything: `rm -rf ./data/managed-agents.db && npm run dev`
- Check API key: `curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | head -1`
