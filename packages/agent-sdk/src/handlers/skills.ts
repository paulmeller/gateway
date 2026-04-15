/**
 * Skills catalog handlers.
 *
 * Phase 1: Feed-based (top 50 per leaderboard from agentstep.com feed)
 * Phase 2: Full index search (72k+ skills with filters, pagination, sorting)
 */
import { routeWrap, jsonOk } from "../http";
import {
  getFeed,
  getIndex,
  searchSkills,
  getStats,
  getSources,
  type SearchOptions,
} from "../lib/skills-cache";

/** GET /v1/skills/catalog — legacy feed proxy (kept for backward compat) */
export async function handleGetSkillsCatalog(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const leaderboard = url.searchParams.get("leaderboard") || "trending";
    const feed = await getFeed();
    const skills =
      leaderboard === "hot" ? feed.topHot :
      leaderboard === "allTime" ? feed.topAllTime :
      feed.topTrending;
    const limit = Number(url.searchParams.get("limit") || "50");
    return jsonOk({ skills: skills.slice(0, limit), total: skills.length });
  });
}

/** GET /v1/skills — search full index */
export async function handleSearchSkills(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const opts: SearchOptions = {
      q: url.searchParams.get("q") || undefined,
      owner: url.searchParams.get("owner") || undefined,
      source: url.searchParams.get("source") || url.searchParams.get("repo") || undefined,
      sort: (url.searchParams.get("sort") as SearchOptions["sort"]) || undefined,
      limit: Number(url.searchParams.get("limit") || "50"),
      offset: Number(url.searchParams.get("offset") || "0"),
    };
    const result = await searchSkills(opts);
    return jsonOk(result);
  });
}

/** GET /v1/skills/stats */
export async function handleGetSkillsStats(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const stats = await getStats();
    return jsonOk(stats);
  });
}

/** GET /v1/skills/sources — aggregated sources sorted by installs */
export async function handleGetSkillsSources(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") || "100");
    const offset = Number(url.searchParams.get("offset") || "0");
    const sources = await getSources();
    return jsonOk({
      data: sources.slice(offset, offset + limit),
      total: sources.length,
    });
  });
}

/** GET /v1/skills/index — serve full index directly */
export async function handleGetSkillsIndex(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const index = await getIndex();
    return jsonOk(index);
  });
}

/** GET /v1/skills/feed — raw feed data */
export async function handleGetSkillsFeed(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const feed = await getFeed();
    return jsonOk(feed);
  });
}
