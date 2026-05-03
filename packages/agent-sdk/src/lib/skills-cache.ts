/**
 * Skills cache — singleton promise pattern with TTL + ETag conditional requests.
 *
 * Two caches:
 *   1. Feed (1h TTL) — top 50 per leaderboard with inline descriptions (~200KB)
 *   2. Full index (6h TTL, 30s fetch timeout) — 72k+ skills, no inline descriptions (~40MB)
 *
 * Both use stale-while-error: if a refresh fails, the stale data is kept.
 * ETag conditional requests avoid re-downloading unchanged data.
 *
 * URL sourcing, highest precedence first:
 *   1. SKILLS_FEED_URL / SKILLS_INDEX_URL env vars
 *   2. `skills_feed_url` / `skills_index_url` settings table entries
 *   3. Compiled defaults (agentstep.com)
 *
 * This lets operators point at their own mirror (e.g. for air-gapped
 * deployments) without editing code or rebuilding.
 */
import { readSetting } from "../config";

const DEFAULT_FEED_URL = "https://www.agentstep.com/v1/skills/feed";
const DEFAULT_INDEX_URL = "https://www.agentstep.com/v1/skills/index";

function resolveFeedUrl(): string {
  return process.env.SKILLS_FEED_URL
    || readSetting("skills_feed_url")
    || DEFAULT_FEED_URL;
}

function resolveIndexUrl(): string {
  return process.env.SKILLS_INDEX_URL
    || readSetting("skills_index_url")
    || DEFAULT_INDEX_URL;
}

const FEED_TTL_MS = 60 * 60 * 1000;    // 1 hour
const INDEX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INDEX_FETCH_TIMEOUT_MS = 30_000;

// --- Types ---

export interface FeedSkill {
  id: string;
  title: string;
  source: string;
  installs: number;
  link: string;
  providerId: string;
  description: string;
}

export interface FeedData {
  title: string;
  updatedAt: string;
  topAllTime: FeedSkill[];
  topTrending: FeedSkill[];
  topHot: FeedSkill[];
}

export interface IndexSkill {
  id: string;
  providerId: string;
  source: string;
  skillId: string;
  title: string;
  link: string;
  installsAllTime: number;
  installsTrending: number;
  installsHot: number;
  firstSeenAt: string;
  description?: string;
  skillMdPath?: string;
}

export interface IndexData {
  updatedAt: string;
  count: number;
  items: IndexSkill[];
}

// --- Cache entries ---

interface CacheEntry<T> {
  data: T | null;
  fetchedAt: number;
  etag: string | null;
  promise: Promise<T> | null;
}

const feedCache: CacheEntry<FeedData> = { data: null, fetchedAt: 0, etag: null, promise: null };
const indexCache: CacheEntry<IndexData> = { data: null, fetchedAt: 0, etag: null, promise: null };

// Pre-sorted views — built once when index loads, avoids re-sorting 72k items per search
let sortedViews: {
  allTime: IndexSkill[];
  trending: IndexSkill[];
  hot: IndexSkill[];
  newest: IndexSkill[];
} | null = null;

function buildSortedViews(items: IndexSkill[]) {
  sortedViews = {
    allTime: [...items].sort((a, b) => b.installsAllTime - a.installsAllTime),
    trending: [...items].sort((a, b) => b.installsTrending - a.installsTrending),
    hot: [...items].sort((a, b) => b.installsHot - a.installsHot),
    newest: [...items].sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime()),
  };
}

// --- Feed ---

/**
 * Normalize raw feed JSON into FeedData. Accepts two shapes:
 *   1. Native: { topAllTime, topTrending, topHot, updatedAt }
 *   2. learn-skills.dev: { allTime: [{source, skillId, name, installs}], updatedAt, providerId }
 */
function normalizeFeed(raw: unknown): FeedData {
  const r = raw as Record<string, unknown>;
  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString();

  // Native format — already has topAllTime
  if (Array.isArray(r.topAllTime)) {
    return {
      title: typeof r.title === "string" ? r.title : "Skills",
      updatedAt,
      topAllTime: r.topAllTime as FeedSkill[],
      topTrending: (r.topTrending ?? r.topAllTime) as FeedSkill[],
      topHot: (r.topHot ?? r.topAllTime) as FeedSkill[],
    };
  }

  // learn-skills.dev format — { allTime: [{source, skillId, name, installs}] }
  const allTime = (r.allTime ?? r.items ?? r.skills) as Array<Record<string, unknown>> | undefined;
  const providerId = typeof r.providerId === "string" ? r.providerId : "skills.sh";
  if (Array.isArray(allTime) && allTime.length > 0) {
    const mapped: FeedSkill[] = allTime.slice(0, 50).map((s) => ({
      id: (s.skillId ?? s.id ?? `${s.source}/${s.name}`) as string,
      title: (s.name ?? s.title ?? s.skillId) as string,
      source: (s.source ?? "") as string,
      installs: (s.installs ?? s.installsAllTime ?? 0) as number,
      link: (s.link ?? `https://github.com/${s.source}`) as string,
      providerId: (s.providerId ?? providerId) as string,
      description: (s.description ?? "") as string,
    }));
    return { title: "Skills", updatedAt, topAllTime: mapped, topTrending: mapped, topHot: mapped };
  }

  // Empty / unknown — return empty feed
  return { title: "Skills", updatedAt, topAllTime: [], topTrending: [], topHot: [] };
}

async function fetchFeed(): Promise<FeedData> {
  const headers: Record<string, string> = {};
  if (feedCache.etag) headers["If-None-Match"] = feedCache.etag;

  const res = await fetch(resolveFeedUrl(), { headers });
  if (res.status === 304 && feedCache.data) {
    feedCache.fetchedAt = Date.now();
    return feedCache.data;
  }
  const etag = res.headers.get("etag");
  const data = normalizeFeed(await res.json());
  feedCache.data = data;
  feedCache.fetchedAt = Date.now();
  feedCache.etag = etag;
  return data;
}

export function getFeed(): Promise<FeedData> {
  const now = Date.now();
  if (feedCache.data && now - feedCache.fetchedAt < FEED_TTL_MS) {
    return Promise.resolve(feedCache.data);
  }
  if (feedCache.promise) return feedCache.promise;

  feedCache.promise = fetchFeed()
    .catch((err) => {
      // Stale-while-error
      if (feedCache.data) return feedCache.data;
      throw err;
    })
    .finally(() => {
      feedCache.promise = null;
    });
  return feedCache.promise;
}

// --- Full index ---

/**
 * Normalize the index response into IndexData. Accepts three shapes:
 *   1. Native: { updatedAt, count, items: IndexSkill[] }
 *   2. Agentstep: { updatedAt, totalSkills, skills: IndexSkill[] }
 *   3. learn-skills.dev: { updatedAt, providerId, allTime: [{source, skillId, name, installs}] }
 */
function normalizeIndex(raw: unknown): IndexData {
  const r = raw as Record<string, unknown>;
  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString();

  // Native or agentstep format
  const items = (r.items ?? r.skills) as IndexSkill[] | undefined;
  if (Array.isArray(items) && items.length > 0 && typeof items[0] === "object" && "installsAllTime" in (items[0] as object)) {
    const count = (r.count ?? r.totalSkills) as number | undefined;
    return { updatedAt, count: typeof count === "number" ? count : items.length, items };
  }

  // learn-skills.dev format
  const allTime = (r.allTime ?? items) as Array<Record<string, unknown>> | undefined;
  const providerId = typeof r.providerId === "string" ? r.providerId : "skills.sh";
  if (Array.isArray(allTime) && allTime.length > 0) {
    const mapped: IndexSkill[] = allTime.map((s) => ({
      id: (s.skillId ?? s.id ?? `${s.source}/${s.name}`) as string,
      providerId: (s.providerId ?? providerId) as string,
      source: (s.source ?? "") as string,
      skillId: (s.skillId ?? s.name ?? s.id) as string,
      title: (s.name ?? s.title ?? s.skillId) as string,
      link: (s.link ?? `https://github.com/${s.source}`) as string,
      installsAllTime: (s.installs ?? s.installsAllTime ?? 0) as number,
      installsTrending: (s.installs ?? s.installsTrending ?? 0) as number,
      installsHot: (s.installs ?? s.installsHot ?? 0) as number,
      firstSeenAt: (s.firstSeenAt ?? "") as string,
      description: (s.description ?? "") as string,
    }));
    return { updatedAt, count: mapped.length, items: mapped };
  }

  return { updatedAt, count: 0, items: [] };
}

async function fetchIndex(): Promise<IndexData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INDEX_FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (indexCache.etag) headers["If-None-Match"] = indexCache.etag;

    const res = await fetch(resolveIndexUrl(), { headers, signal: controller.signal });
    if (res.status === 304 && indexCache.data) {
      indexCache.fetchedAt = Date.now();
      return indexCache.data;
    }
    const etag = res.headers.get("etag");
    const data = normalizeIndex(await res.json());
    indexCache.data = data;
    indexCache.fetchedAt = Date.now();
    indexCache.etag = etag;
    buildSortedViews(data.items);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function getIndex(): Promise<IndexData> {
  const now = Date.now();
  if (indexCache.data && now - indexCache.fetchedAt < INDEX_TTL_MS) {
    return Promise.resolve(indexCache.data);
  }
  if (indexCache.promise) return indexCache.promise;

  indexCache.promise = fetchIndex()
    .catch((err) => {
      if (indexCache.data) return indexCache.data;
      throw err;
    })
    .finally(() => {
      indexCache.promise = null;
    });
  return indexCache.promise;
}

// --- Search ---

export interface SearchOptions {
  q?: string;
  owner?: string;
  repo?: string;
  source?: string;
  sort?: "allTime" | "trending" | "hot" | "newest";
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  skills: IndexSkill[];
  total: number;
  limit: number;
  offset: number;
}

export async function searchSkills(opts: SearchOptions): Promise<SearchResult> {
  const index = await getIndex();
  let items: IndexSkill[] = index.items;

  // Fallback: if the index is empty, build searchable items from the feed
  if (items.length === 0) {
    const feed = await getFeed();
    const seen = new Set<string>();
    const fromFeed: IndexSkill[] = [];
    for (const list of [feed.topAllTime, feed.topTrending, feed.topHot]) {
      for (const s of list) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        fromFeed.push({
          id: s.id, providerId: s.providerId, source: s.source,
          skillId: s.id, title: s.title, link: s.link,
          installsAllTime: s.installs, installsTrending: s.installs, installsHot: s.installs,
          firstSeenAt: "", description: s.description,
        });
      }
    }
    items = fromFeed;
  }

  // Filter
  if (opts.q) {
    const q = opts.q.toLowerCase();
    items = items.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q) ||
        s.skillId.toLowerCase().includes(q)
    );
  }
  if (opts.owner) {
    const owner = opts.owner.toLowerCase();
    items = items.filter((s) => s.source.toLowerCase().startsWith(owner + "/"));
  }
  if (opts.repo || opts.source) {
    const src = (opts.source || opts.repo)!.toLowerCase();
    items = items.filter((s) => s.source.toLowerCase() === src);
  }

  // Sort — use pre-sorted views when no filters applied (fast path)
  const sort = opts.sort ?? "allTime";
  const hasFilters = opts.q || opts.owner || opts.source || opts.repo;
  if (!hasFilters && sortedViews && index.items.length > 0) {
    items = sortedViews[sort];
  } else {
    if (sort === "trending") items = [...items].sort((a, b) => b.installsTrending - a.installsTrending);
    else if (sort === "hot") items = [...items].sort((a, b) => b.installsHot - a.installsHot);
    else if (sort === "newest") items = [...items].sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());
    else items = [...items].sort((a, b) => b.installsAllTime - a.installsAllTime);
  }

  const total = items.length;
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const skills = items.slice(offset, offset + limit);

  return { skills, total, limit, offset };
}

// --- Stats ---

export interface SkillsStats {
  totalSkills: number;
  totalSources: number;
  totalOwners: number;
  updatedAt: string;
  feedUpdatedAt: string;
  indexLoaded: boolean;
}

export async function getStats(): Promise<SkillsStats> {
  const feed = await getFeed();

  let totalSkills = 0;
  let totalSources = 0;
  let totalOwners = 0;
  let indexLoaded = false;

  if (indexCache.data) {
    indexLoaded = true;
    totalSkills = indexCache.data.count;
    const sources = new Set<string>();
    const owners = new Set<string>();
    for (const s of indexCache.data.items) {
      sources.add(s.source);
      owners.add(s.source.split("/")[0]);
    }
    totalSources = sources.size;
    totalOwners = owners.size;
  }

  return {
    totalSkills,
    totalSources,
    totalOwners,
    updatedAt: indexCache.data?.updatedAt ?? "",
    feedUpdatedAt: feed.updatedAt,
    indexLoaded,
  };
}

// --- Sources aggregation ---

export interface SourceInfo {
  source: string;
  owner: string;
  skillCount: number;
  totalInstalls: number;
}

export async function getSources(): Promise<SourceInfo[]> {
  const index = await getIndex();
  const map = new Map<string, { count: number; installs: number }>();
  for (const s of index.items) {
    const entry = map.get(s.source);
    if (entry) {
      entry.count++;
      entry.installs += s.installsAllTime;
    } else {
      map.set(s.source, { count: 1, installs: s.installsAllTime });
    }
  }
  return Array.from(map.entries())
    .map(([source, { count, installs }]) => ({
      source,
      owner: source.split("/")[0],
      skillCount: count,
      totalInstalls: installs,
    }))
    .sort((a, b) => b.totalInstalls - a.totalInstalls);
}
