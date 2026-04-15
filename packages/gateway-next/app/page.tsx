import { handleGetUI } from "@agentstep/agent-sdk/handlers";

export const runtime = "nodejs";

export default async function Home() {
  const res = await handleGetUI({ apiKey: process.env.SEED_API_KEY });
  const html = await res.text();
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
