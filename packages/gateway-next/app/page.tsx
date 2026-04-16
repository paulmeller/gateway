import { headers } from "next/headers";
import { handleGetUI } from "@agentstep/agent-sdk/handlers";

export const runtime = "nodejs";

/**
 * Only inject the API key for loopback requests. On a public bind, the
 * UI still loads — it just falls back to localStorage / manual paste
 * for auth instead of auto-logging in with an exposed server key.
 */
async function isLoopbackRequest(): Promise<boolean> {
  // Next.js 15: headers() is async
  const h = await headers();
  // When deployed behind a proxy, trust the leftmost X-Forwarded-For only
  // if you explicitly set TRUST_PROXY=1. Otherwise rely on the direct
  // remote address exposed by Next.
  const trustProxy = process.env.TRUST_PROXY === "1";
  const forwardedFor = trustProxy ? h.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  const remote = forwardedFor ?? h.get("x-real-ip") ?? "";
  const addr = remote.replace(/^::ffff:/, "");
  // If no address is available (some Node adapters don't expose it to
  // Next), default to *not* injecting the key — safer.
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

export default async function Home() {
  const apiKey = (await isLoopbackRequest()) ? process.env.SEED_API_KEY : undefined;
  const res = await handleGetUI({ apiKey });
  const html = await res.text();
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
