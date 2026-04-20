# Tenants

AgentStep Gateway v0.5 groups every API key, agent, environment, vault,
and session under a **tenant**. A tenant is a hard isolation boundary —
tenant admins see only their own tenant's resources, global admins see
everything.

If you run the gateway for yourself or a single team, you can ignore
tenants entirely: new installs seed a `tenant_default` tenant on first
boot and the included seed key is a global admin, so everything keeps
working exactly the way it did on 0.4.

## The three roles

| Role | `permissions.admin` | `tenant_id` | Can see / do |
|------|---------------------|-------------|--------------|
| Global admin | `true` | `null` | Everything, across every tenant. Manages tenants + upstream-key pool. |
| Tenant admin | `true` | `X` | Everything inside tenant `X`. Creates/revokes keys in `X`. |
| Tenant user | `false` | `X` | Resources in `X` that match the key's scope (`agents`/`environments`/`vaults` allow-lists from v0.4). |

A pre-v0.5 key stored with the legacy `["*"]` permission hydrates as
`{admin: true, scope: null}`. Combined with a null `tenant_id` (the
default for pre-v0.5 rows), it becomes a global admin automatically —
no migration needed.

## Creating a tenant

```bash
gateway tenants create acme
# → tenant_01KPB…  name="acme"

gateway tenants list
gateway tenants rename tenant_01KPB… "ACME Corp"
gateway tenants archive tenant_01KPB…
```

Via API (global admin only):

```http
POST /v1/tenants
Content-Type: application/json

{ "name": "acme", "id": "tenant_acme" }   # id is optional
```

## Creating a tenant admin key

From the `/api-keys` page, click "Create key" and pass `tenant_id:
tenant_acme` — the UI exposes this for global admins. Or via API:

```http
POST /v1/api-keys
{
  "name": "acme-admin",
  "permissions": { "admin": true, "scope": null },
  "tenant_id": "tenant_acme"
}
```

The raw key is returned *once* — store it.

Then any call made with that key's `x-api-key` header will automatically
see only `tenant_acme` resources, create new resources inside
`tenant_acme`, and be barred from `/v1/tenants` and `/v1/upstream-keys`.

## 0.4 → 0.5 upgrade

Nothing auto-migrates. Existing agents/envs/vaults/sessions keep
`tenant_id = null`, which means *only global admins can see them*. Your
seed key is a global admin, so day-to-day operation is unchanged.

When you're ready to move existing resources into a real tenant:

```bash
gateway tenants migrate-legacy           # interactive, shows counts first
gateway tenants migrate-legacy --yes     # non-interactive, for CI
gateway tenants migrate-legacy --tenant tenant_acme
```

The migration runs inside a single SQLite transaction — it either
assigns every null-tenant row or none of them.

`api_keys` are *not* migrated automatically: a global-admin key has
genuinely different semantics from a tenant-admin key, so the choice is
explicit via `PATCH /v1/api-keys/:id`.

## Cross-tenant access semantics

Cross-tenant reads and writes return **404, not 403**. This prevents
id-probing: a tenant admin can't tell whether `agent_xyz` exists in
another tenant or doesn't exist at all.

For sessions specifically:

- The agent and environment used to create a session must share a
  tenant — cross-tenant agent+env pairs are rejected with a 400.
- The session's `tenant_id` is stamped from the agent's tenant.
- Fallback tuples must also share the primary agent's tenant; mis-
  configured cross-tenant fallbacks are silently skipped with a clear
  reason in the exhaustion error (e.g. `fallback agent is in a different
  tenant`).

## Globally-scoped resources

These are visible to the global admin only, *not* to tenant admins:

- `/v1/tenants` (managing the list of tenants itself)
- `/v1/upstream-keys` (the shared upstream provider-key pool)
- `/v1/metrics/api` (the in-process throughput snapshot, which isn't
  tenant-partitioned)
- The full audit log (`/v1/audit-log` with no filter). Tenant admins can
  query the audit log but only see entries for their own tenant.
