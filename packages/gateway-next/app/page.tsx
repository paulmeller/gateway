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
  // Both x-forwarded-for AND x-real-ip are trivially spoofable by any
  // client — they must only be trusted when the operator has explicitly
  // said "I put a proxy in front that sanitizes these headers" via
  // TRUST_PROXY=1. Without that flag, fail closed (no key injection).
  // This matches the safer default of the Hono adapter, which reads the
  // raw socket address only.
  const trustProxy = process.env.TRUST_PROXY === "1";
  if (!trustProxy) return false;

  const forwardedFor = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = h.get("x-real-ip") ?? undefined;
  const remote = forwardedFor ?? realIp ?? "";
  const addr = remote.replace(/^::ffff:/, "");
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

export default async function Home() {
  const apiKey = (await isLoopbackRequest()) ? process.env.SEED_API_KEY : undefined;
  const res = await handleGetUI({ apiKey });
  const html = await res.text();
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
