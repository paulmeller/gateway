# Telemetry

AgentStep Gateway can send anonymous CLI usage events to help us improve the
tool. It's off by default and requires explicit opt-in on first run.

## What we collect

For each CLI command, if telemetry is enabled, one POST is made to
`https://api.agentstep.com/v1/telemetry` with:

```json
{
  "event": "cli.command",
  "command": "agents create",
  "backend_type": "local",
  "provider": "docker",
  "success": true,
  "cli_version": "0.4.0",
  "os": "darwin",
  "arch": "arm64",
  "node_version": "v22.11.0",
  "timestamp": "2026-04-16T10:12:34.567Z"
}
```

That's the full payload. Source: [`packages/gateway/src/telemetry/track.ts`](../packages/gateway/src/telemetry/track.ts).

## What we never collect

- Your prompts, messages, tool calls, or agent outputs
- API keys, vault entries, or any secret material
- File paths, environment variables, or repo contents
- IP addresses are not attached to events by the CLI (whatever the HTTP
  layer sees at the receiving end is not joined back to your device)
- User IDs — there is no client-generated identifier

## How to opt out

Three options, any of them works:

### 1. Decline the prompt
The first time you run a non-trivial CLI command, we ask:
> Send anonymous command usage …? (default: No)

Pressing Enter accepts the default and telemetry stays off.

### 2. Environment variable
Set either of these before running any command:
```bash
export DO_NOT_TRACK=1
# or
export GATEWAY_NO_TELEMETRY=1
```
These take precedence over the config file.

### 3. CLI config
```bash
gateway config set telemetry false
```
This persists to your CLI config (`~/.config/agentstep/config.json` on
Unix). Change to `true` to re-enable.

## Web UI and server

The CLI is the only surface that emits telemetry. `gateway serve`, the web
UI, and the `@agentstep/agent-sdk` library do not emit anything. The
server is offline-capable and never dials out.

## Privacy

Source is open — see [`packages/gateway/src/telemetry/`](../packages/gateway/src/telemetry/)
for the full implementation. If anything looks wrong, open an issue or
email security@agentstep.com.
