/**
 * User profiles: per-user credential scoping via trust grants.
 *
 * A user profile maps an external user identity to a set of trust grants.
 * Each trust grant binds the user to specific vault credentials, controlling
 * which credentials are available during their agent sessions.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";

export interface TrustGrant {
  type: "vault_credential";
  vault_id: string;
  credential_id: string;
}

export interface UserProfile {
  type: "user_profile";
  id: string;
  external_id: string | null;
  display_name: string | null;
  trust_grants: TrustGrant[];
  tenant_id: string | null;
  created_at: string;
  updated_at: string;
}

interface UserProfileRow {
  id: string;
  external_id: string | null;
  display_name: string | null;
  trust_grants_json: string;
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(row: UserProfileRow): UserProfile {
  return {
    type: "user_profile",
    id: row.id,
    external_id: row.external_id,
    display_name: row.display_name,
    trust_grants: JSON.parse(row.trust_grants_json) as TrustGrant[],
    tenant_id: row.tenant_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function createUserProfile(input: {
  external_id?: string | null;
  display_name?: string | null;
  trust_grants?: TrustGrant[];
  tenant_id?: string | null;
}): UserProfile {
  const db = getDb();
  const id = newId("uprof");
  const now = nowMs();
  db.prepare(
    `INSERT INTO user_profiles (id, external_id, display_name, trust_grants_json, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.external_id ?? null,
    input.display_name ?? null,
    JSON.stringify(input.trust_grants ?? []),
    input.tenant_id ?? null,
    now,
    now,
  );
  return getUserProfile(id)!;
}

export function getUserProfile(id: string): UserProfile | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM user_profiles WHERE id = ?`).get(id) as UserProfileRow | undefined;
  return row ? hydrate(row) : null;
}

export function listUserProfiles(opts: {
  tenant_id?: string | null;
  limit?: number;
  after_id?: string;
}): { data: UserProfile[]; has_more: boolean } {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 100);
  const parts: string[] = [];
  const args: unknown[] = [];

  if (opts.tenant_id) {
    parts.push("tenant_id = ?");
    args.push(opts.tenant_id);
  }
  if (opts.after_id) {
    parts.push("id > ?");
    args.push(opts.after_id);
  }

  const where = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM user_profiles ${where} ORDER BY id ASC LIMIT ?`,
  ).all(...args, limit + 1) as UserProfileRow[];

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return { data: rows.map(hydrate), has_more: hasMore };
}

export function updateUserProfile(id: string, input: {
  external_id?: string | null;
  display_name?: string | null;
  trust_grants?: TrustGrant[];
}): UserProfile | null {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM user_profiles WHERE id = ?`).get(id) as UserProfileRow | undefined;
  if (!existing) return null;

  const now = nowMs();
  const parts: string[] = ["updated_at = ?"];
  const args: unknown[] = [now];

  if (input.external_id !== undefined) { parts.push("external_id = ?"); args.push(input.external_id); }
  if (input.display_name !== undefined) { parts.push("display_name = ?"); args.push(input.display_name); }
  if (input.trust_grants !== undefined) { parts.push("trust_grants_json = ?"); args.push(JSON.stringify(input.trust_grants)); }

  db.prepare(`UPDATE user_profiles SET ${parts.join(", ")} WHERE id = ?`).run(...args, id);
  return getUserProfile(id);
}
