/**
 * Skill CRUD handlers — standalone, DB-stored skills with versioning.
 *
 * POST   /v1/skills                         — create skill + first version
 * GET    /v1/skills/:id                     — get skill
 * DELETE /v1/skills/:id                     — hard delete skill + all versions
 * POST   /v1/skills/:id/versions            — create new version
 * GET    /v1/skills/:id/versions            — list versions
 * GET    /v1/skills/:id/versions/:version   — get specific version
 * DELETE /v1/skills/:id/versions/:version   — delete version (cannot delete current)
 */
import { z } from "zod";
import { inflateRawSync } from "node:zlib";
import { routeWrap, jsonOk, paginatedOk, decodeCursor } from "../http";
import { badRequest, notFound } from "../errors";
import {
  createSkill,
  getSkill,
  listSkills,
  deleteSkill,
  createSkillVersion,
  getSkillVersion,
  listSkillVersions,
  deleteSkillVersion,
} from "../db/skills";
import { resolveCreateTenant, tenantFilter } from "../auth/scope";

// ---------------------------------------------------------------------------
// Zip parser — minimal Local File Header reader (supports stored + deflate)
// ---------------------------------------------------------------------------

/**
 * Extract files from a zip buffer.  Walks Local File Headers (signature
 * 0x04034b50) and supports compression methods 0 (stored) and 8 (deflate).
 * Returns a Map<filename, Buffer> for each entry.
 */
function extractFromZipRaw(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // not a Local File Header — stop
    const compMethod = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;

    if (compMethod === 0) {
      // Stored — no compression
      files.set(name, buffer.subarray(dataStart, dataStart + uncompSize));
    } else if (compMethod === 8) {
      // Deflate — use Node's zlib inflateRaw
      const compressed = buffer.subarray(dataStart, dataStart + compSize);
      files.set(name, inflateRawSync(compressed));
    }
    // Skip entries with unknown compression methods

    offset = dataStart + compSize;
  }
  return files;
}

/** File extensions treated as text (stored as UTF-8). Everything else is stored as base64. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".bash",
  ".json", ".yaml", ".yml", ".html", ".css", ".xml", ".csv", ".toml",
  ".cfg", ".ini", ".sql", ".rb", ".go", ".rs", ".c", ".h", ".cpp",
  ".java", ".kt", ".swift", ".r", ".pl", ".lua", ".env", ".gitignore",
  ".dockerfile", ".makefile", ".cmake", ".conf", ".properties", ".lock",
]);

/** Determine if a filename should be treated as text based on extension. */
function isTextFile(name: string): boolean {
  if (name.endsWith("/")) return false; // directory entry
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx === -1) return true; // no extension — treat as text
  return TEXT_EXTENSIONS.has(name.substring(dotIdx).toLowerCase());
}

/**
 * Convert raw zip entries to string content. Text files are stored as UTF-8;
 * binary files are stored with a "base64:" prefix.
 */
function convertZipEntries(raw: Map<string, Buffer>): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, buf] of raw) {
    if (isTextFile(name)) {
      files.set(name, buf.toString("utf-8"));
    } else {
      files.set(name, "base64:" + buf.toString("base64"));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateSkillSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  content: z.string().min(1).max(256 * 1024), // 256 KB
  tenant_id: z.string().optional(),
});

const CreateVersionSchema = z.object({
  content: z.string().min(1).max(256 * 1024),
  version: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /v1/skills */
export function handleCreateSkill(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const contentType = request.headers.get("content-type") ?? "";

    let name: string;
    let description: string | undefined;
    let content: string;
    let filesMap: Record<string, string> | undefined;
    let tenantId: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      // Anthropic deploy-managed-agent.sh format:
      //   -F "display_title=skill-name" -F "files[]=@skill.zip"
      const formData = await request.formData();
      name = ((formData.get("display_title") as string | null) ?? "").trim() || "untitled";

      const file =
        formData.get("files[]") ??
        formData.get("files") ??
        formData.get("file");
      if (!file || !(file instanceof File)) {
        throw badRequest("Missing file in multipart upload");
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      if (file.name?.toLowerCase().endsWith(".zip")) {
        // Extract all files from zip archive
        const rawEntries = extractFromZipRaw(buffer);
        const zipFiles = convertZipEntries(rawEntries);

        // Find SKILL.md for the primary content
        const skillEntry = [...zipFiles.entries()].find(
          ([k]) => k.endsWith("SKILL.md") || k.endsWith("skill.md"),
        );
        if (!skillEntry) {
          throw badRequest("No SKILL.md found in zip archive");
        }
        content = skillEntry[1];

        // Build files map — all files with paths relative to the skill root
        const builtFiles: Record<string, string> = {};
        const prefix = skillEntry[0].substring(0, skillEntry[0].lastIndexOf("/") + 1);
        for (const [path, fileContent] of zipFiles.entries()) {
          if (path.endsWith("/")) continue; // skip directories
          const relativePath = path.startsWith(prefix) ? path.slice(prefix.length) : path;
          builtFiles[relativePath] = fileContent;
        }
        // Only set filesMap if there are files beyond SKILL.md
        if (Object.keys(builtFiles).length > 1 || !builtFiles["SKILL.md"]) {
          filesMap = builtFiles;
        }
      } else {
        // Raw markdown / text file
        content = buffer.toString("utf-8");
      }

      tenantId = resolveCreateTenant(auth, undefined);
    } else {
      // JSON body (native format)
      const body = await request.json().catch(() => null);
      const parsed = CreateSkillSchema.safeParse(body);
      if (!parsed.success) {
        throw badRequest(
          `invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      name = parsed.data.name;
      description = parsed.data.description;
      content = parsed.data.content;
      tenantId = resolveCreateTenant(auth, parsed.data.tenant_id);
    }

    const skill = createSkill({ name, description, content, files: filesMap, tenantId });
    return jsonOk(skill, 201);
  });
}

/** GET /v1/skills/:id */
export function handleGetSkill(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const skill = getSkill(skillId);
    if (!skill) throw notFound(`skill ${skillId} not found`);
    return jsonOk(skill);
  });
}

/** DELETE /v1/skills/:id */
export function handleDeleteSkill(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const ok = deleteSkill(skillId);
    if (!ok) throw notFound(`skill ${skillId} not found`);
    return jsonOk({ id: skillId, type: "skill_deleted" });
  });
}

/** POST /v1/skills/:id/versions */
export function handleCreateSkillVersion(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json().catch(() => null);
    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        `invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    const sv = createSkillVersion(skillId, {
      content: parsed.data.content,
      version: parsed.data.version,
    });
    if (!sv) throw notFound(`skill ${skillId} not found`);

    return jsonOk(sv, 201);
  });
}

/** GET /v1/skills/:id/versions */
export function handleListSkillVersions(
  request: Request,
  skillId: string,
): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    // Verify skill exists
    const skill = getSkill(skillId);
    if (!skill) throw notFound(`skill ${skillId} not found`);

    const url = new URL(req.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") || "20"), 1),
      100,
    );
    const cursor = decodeCursor(url.searchParams.get("after_id"));

    const versions = listSkillVersions(skillId, { limit, cursor });
    return paginatedOk(versions, limit);
  });
}

/** GET /v1/skills/:id/versions/:version */
export function handleGetSkillVersion(
  request: Request,
  skillId: string,
  version: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const sv = getSkillVersion(skillId, version);
    if (!sv) throw notFound(`skill version ${version} not found`);
    return jsonOk(sv);
  });
}

/** DELETE /v1/skills/:id/versions/:version */
export function handleDeleteSkillVersion(
  request: Request,
  skillId: string,
  version: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    const result = deleteSkillVersion(skillId, version);
    if (!result.ok) {
      if (result.reason === "cannot delete the current version") {
        throw badRequest(result.reason);
      }
      throw notFound(`skill version ${version} not found`);
    }
    return jsonOk({ skill_id: skillId, version, type: "skill_version_deleted" });
  });
}
