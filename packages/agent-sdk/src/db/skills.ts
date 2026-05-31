/**
 * Skills DB layer — CRUD for standalone, DB-stored skills with versioning.
 *
 * Each skill has a `skills` row and one or more `skill_versions` rows.
 * The first version is "1.0.0"; subsequent versions auto-increment the
 * patch number unless an explicit version string is provided.
 */
import { eq, and, isNull, lt, desc } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Skill, SkillVersion } from "../types";

// ---------------------------------------------------------------------------
// Hydration helpers
// ---------------------------------------------------------------------------

function hydrateSkill(row: {
  id: string;
  name: string;
  description: string | null;
  current_version: string | null;
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}): Skill {
  return {
    // ─── Anthropic CMA-compat (canonical) ──────────────────────────
    id: row.id,
    display_title: row.name,
    source: "custom",
    latest_version: row.current_version ?? "",
    created_at: toIso(row.created_at),
    // ─── AgentStep extensions (not in Anthropic CMA) ───────────────
    description: row.description ?? "",
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
  };
}

function hydrateSkillVersion(row: {
  id: string;
  skill_id: string;
  version: string;
  content: string;
  files_json?: string;
  created_at: number;
}): SkillVersion {
  const filesJson = row.files_json ?? "{}";
  const files = JSON.parse(filesJson) as Record<string, string>;
  const hasFiles = Object.keys(files).length > 0;
  return {
    type: "skill_version",
    id: row.id,
    skill_id: row.skill_id,
    version: row.version,
    content: row.content,
    ...(hasFiles ? { files } : {}),
    created_at: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Skill CRUD
// ---------------------------------------------------------------------------

export function createSkill(input: {
  name: string;
  description?: string;
  content: string;
  files?: Record<string, string>;
  tenantId?: string;
}): Skill {
  const db = getDrizzle();
  const id = newId("skill");
  const versionId = newId("sklv");
  // Version format: epoch-microsecond timestamp, matching Anthropic's
  // Skills API convention (e.g. "1759178010641129"). Old semver values
  // ("1.0.0", "1.0.1") in the DB still resolve via exact-match lookup
  // — only newly-created skills + versions use the new format.
  const version = nextVersionId();
  const now = nowMs();

  db.transaction((tx) => {
    tx.insert(schema.skills).values({
      id,
      name: input.name,
      description: input.description ?? null,
      current_version: version,
      tenant_id: input.tenantId ?? null,
      created_at: now,
      updated_at: now,
    }).run();

    tx.insert(schema.skillVersions).values({
      id: versionId,
      skill_id: id,
      version,
      content: input.content,
      files_json: JSON.stringify(input.files ?? {}),
      created_at: now,
    }).run();
  });

  return getSkill(id)!;
}

export function getSkill(id: string): Skill | undefined {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.id, id))
    .get();
  if (!row) return undefined;
  return hydrateSkill(row as typeof row & { id: string; name: string; created_at: number; updated_at: number });
}

export function listSkills(opts?: {
  limit?: number;
  cursor?: string;
  tenantId?: string;
  includeArchived?: boolean;
}): Skill[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const includeArchived = opts?.includeArchived ?? false;

  const conditions = [];
  if (!includeArchived) conditions.push(isNull(schema.skills.archived_at));
  if (opts?.cursor) {
    conditions.push(lt(schema.skills.id, opts.cursor));
  }
  if (opts?.tenantId != null) {
    conditions.push(eq(schema.skills.tenant_id, opts.tenantId));
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = (
    where
      ? db.select().from(schema.skills).where(where).orderBy(desc(schema.skills.id)).limit(limit).all()
      : db.select().from(schema.skills).orderBy(desc(schema.skills.id)).limit(limit).all()
  );

  return rows.map((r) => hydrateSkill(r as typeof r & { id: string; name: string; created_at: number; updated_at: number }));
}

export function deleteSkill(id: string): boolean {
  const db = getDrizzle();
  // Hard delete: remove all versions first, then the skill row.
  let deleted = false;
  db.transaction((tx) => {
    tx.delete(schema.skillVersions)
      .where(eq(schema.skillVersions.skill_id, id))
      .run();
    const res = tx.delete(schema.skills)
      .where(eq(schema.skills.id, id))
      .run();
    deleted = res.changes > 0;
  });
  return deleted;
}

// ---------------------------------------------------------------------------
// Skill Version CRUD
// ---------------------------------------------------------------------------

/**
 * Auto-increment a semver patch version. "1.0.0" -> "1.0.1", etc.
 */
// Anthropic Skills API uses epoch-microsecond timestamps for version
// IDs (e.g. "1759178010641129"). Migrating to that convention so
// pinned `{ skill_id, version }` refs survive across SDKs without
// translation. Old semver versions stored from before 0.5.57 still
// resolve via exact match — this only affects the next-version
// generator.
//
// Node's millisecond clock can give the same `Date.now()` for rapid
// successive calls; the in-process counter below guarantees strict
// monotonicity ("v_next > v_prev") even within a single millisecond.
// Behaves like an epoch microsecond clock for normal-paced traffic and
// degrades to a counter-on-millisecond for tight loops (tests, batches).
let _lastSkillVersion = 0;
function nextVersionId(): string {
  let v = nowMs() * 1000;
  if (v <= _lastSkillVersion) v = _lastSkillVersion + 1;
  _lastSkillVersion = v;
  return String(v);
}

function autoIncrement(_current: string): string {
  return nextVersionId();
}

export function createSkillVersion(
  skillId: string,
  input: { content: string; files?: Record<string, string>; version?: string },
): SkillVersion | undefined {
  const db = getDrizzle();

  const skill = db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.id, skillId))
    .get();
  if (!skill) return undefined;

  const version = input.version ?? autoIncrement(skill.current_version ?? "1.0.0");
  const id = newId("sklv");
  const now = nowMs();

  db.transaction((tx) => {
    tx.insert(schema.skillVersions).values({
      id,
      skill_id: skillId,
      version,
      content: input.content,
      files_json: JSON.stringify(input.files ?? {}),
      created_at: now,
    }).run();

    tx.update(schema.skills)
      .set({ current_version: version, updated_at: now })
      .where(eq(schema.skills.id, skillId))
      .run();
  });

  return getSkillVersion(skillId, version);
}

export function getSkillVersion(
  skillId: string,
  version: string,
): SkillVersion | undefined {
  const db = getDrizzle();

  // Convention: `version: "latest"` resolves to the skill's current_version.
  // Matches the documented agent-tool pattern `{ type: "custom", skill_id,
  // version: "latest" }` so callers don't have to pin to an explicit string.
  let resolvedVersion = version;
  if (version === "latest") {
    const skill = db
      .select({ current_version: schema.skills.current_version })
      .from(schema.skills)
      .where(eq(schema.skills.id, skillId))
      .get();
    if (!skill?.current_version) return undefined;
    resolvedVersion = skill.current_version;
  }

  const row = db
    .select()
    .from(schema.skillVersions)
    .where(
      and(
        eq(schema.skillVersions.skill_id, skillId),
        eq(schema.skillVersions.version, resolvedVersion),
      ),
    )
    .get();
  if (!row) return undefined;
  return hydrateSkillVersion(row as typeof row & { id: string; skill_id: string; version: string; content: string; files_json?: string; created_at: number });
}

export function listSkillVersions(
  skillId: string,
  opts?: { limit?: number; cursor?: string },
): SkillVersion[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);

  const conditions = [eq(schema.skillVersions.skill_id, skillId)];
  if (opts?.cursor) {
    conditions.push(lt(schema.skillVersions.id, opts.cursor));
  }

  const rows = db
    .select()
    .from(schema.skillVersions)
    .where(and(...conditions))
    .orderBy(desc(schema.skillVersions.created_at))
    .limit(limit)
    .all();

  return rows.map((r) =>
    hydrateSkillVersion(r as typeof r & { id: string; skill_id: string; version: string; content: string; files_json?: string; created_at: number }),
  );
}

export function deleteSkillVersion(
  skillId: string,
  version: string,
): { ok: boolean; reason?: string } {
  const db = getDrizzle();

  // Cannot delete the current version
  const skill = db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.id, skillId))
    .get();
  if (!skill) return { ok: false, reason: "skill not found" };
  if (skill.current_version === version) {
    return { ok: false, reason: "cannot delete the current version" };
  }

  const res = db
    .delete(schema.skillVersions)
    .where(
      and(
        eq(schema.skillVersions.skill_id, skillId),
        eq(schema.skillVersions.version, version),
      ),
    )
    .run();
  return { ok: res.changes > 0 };
}
