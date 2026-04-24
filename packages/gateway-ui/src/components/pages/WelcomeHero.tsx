import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Play, BookOpen, Copy, Eye, EyeOff, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useProviderStatus } from "@/hooks/use-providers";
import { LOCAL_PROVIDERS, CLOUD_PROVIDERS } from "@/lib/constants";
import { toast } from "sonner";

const VERSION = "0.4.11";
const GITHUB_URL = "https://github.com/agentstep/gateway";

const PROVIDER_DOMAINS: Record<string, string> = {
  docker: "docker.com",
  "apple-container": "apple.com",
  podman: "podman.io",
  sprites: "sprites.dev",
  e2b: "e2b.dev",
  vercel: "vercel.com",
  daytona: "daytona.io",
  fly: "fly.io",
  modal: "modal.com",
  anthropic: "anthropic.com",
};

function maskKey(key: string): string {
  if (key.length <= 10) return "••••••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

interface Props {
  apiKey: string;
}

export function WelcomeHero({ apiKey }: Props) {
  const { data: providerStatus } = useProviderStatus();
  const [revealed, setRevealed] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const curlCmd = `curl http://localhost:4000/v1/agents \\
  -H "x-api-key: ${apiKey || "YOUR_API_KEY"}"`;

  async function copy(text: string, which: "key" | "curl") {
    await navigator.clipboard.writeText(text);
    if (which === "key") {
      setCopiedKey(true);
      toast.success("API key copied");
      setTimeout(() => setCopiedKey(false), 2000);
    } else {
      setCopiedCurl(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedCurl(false), 2000);
    }
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-3rem)] mx-auto max-w-6xl w-full px-6 pt-16 pb-6">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_360px] gap-8 items-start flex-1">
        {/* ── Left column: identity + CTA ────────────────────────── */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-lime-500 shrink-0" />
            <span className="font-mono text-sm font-semibold tracking-tight">agentstep</span>
          </div>

          <div className="flex flex-col gap-3">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground leading-tight">
              Run AI agents in sandboxed environments.
            </h1>
            <p className="text-base text-muted-foreground">
              Start a session below, or use the API.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/quickstart"
              className="inline-flex items-center h-10 px-5 rounded-lg bg-cta-gradient text-sm font-medium text-black hover:opacity-90 transition-opacity"
            >
              <Play className="size-4 mr-1.5" />
              Start Quickstart
            </Link>
            <Link
              to="/docs"
              className="inline-flex items-center h-10 px-5 rounded-lg ring-1 ring-foreground/10 text-sm font-medium text-foreground hover:bg-accent transition-colors"
            >
              <BookOpen className="size-4 mr-1.5" />
              View API Docs
            </Link>
          </div>

          {/* Step strip */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground font-mono">
            <StepPill num="01" label="Agent" />
            <span className="text-muted-foreground/40">→</span>
            <StepPill num="02" label="Environment" />
            <span className="text-muted-foreground/40">→</span>
            <StepPill num="03" label="Secrets" />
            <span className="text-muted-foreground/40">→</span>
            <StepPill num="04" label="Session" />
          </div>

        </div>

        {/* ── Right column: proof panel ──────────────────────────── */}
        <Card className="!py-0 divide-y divide-border">
          {/* curl snippet */}
          <CardContent className="flex flex-col gap-2 py-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Test it</span>
              <button
                onClick={() => copy(curlCmd, "curl")}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {copiedCurl ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            </div>
            <pre className="font-mono text-[11px] text-foreground bg-muted rounded px-2 py-2 whitespace-pre-wrap break-all select-all leading-relaxed">
              {curlCmd}
            </pre>
          </CardContent>

          {/* Provider status chips */}
          <CardContent className="flex flex-col gap-2 py-4">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Providers</span>
            <div className="flex flex-wrap gap-1.5">
              {[...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS].map((p) => {
                const status = providerStatus?.[p];
                const available = CLOUD_PROVIDERS.includes(p as typeof CLOUD_PROVIDERS[number])
                  ? true // cloud providers show as "configurable" not "unavailable"
                  : (status?.available ?? true);
                const isCloud = CLOUD_PROVIDERS.includes(p as typeof CLOUD_PROVIDERS[number]);
                return (
                  <span
                    key={p}
                    title={status?.message ?? (isCloud ? "Configure API key to use" : available ? "Ready" : "Not available")}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ring-1 ${
                      isCloud
                        ? "ring-foreground/10 text-muted-foreground"
                        : available
                          ? "ring-lime-400/20 bg-lime-400/5 text-foreground"
                          : "ring-foreground/10 text-muted-foreground opacity-50"
                    }`}
                  >
                    {!isCloud && (
                      <span
                        className={`size-1.5 rounded-full ${available ? "bg-lime-400" : "bg-muted-foreground/40"}`}
                      />
                    )}
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${PROVIDER_DOMAINS[p] ?? ""}&sz=16`}
                      alt=""
                      className="size-3"
                    />
                    {p}
                  </span>
                );
              })}
            </div>
          </CardContent>

          {/* API Key */}
          <CardContent className="flex flex-col gap-2 py-4">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">API Key</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-[11px] text-foreground bg-muted rounded px-2 py-1.5 break-all select-all">
                {apiKey ? (revealed ? apiKey : maskKey(apiKey)) : "no key"}
              </code>
              <button
                onClick={() => setRevealed((r) => !r)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title={revealed ? "Hide" : "Reveal"}
              >
                {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
              <button
                onClick={() => apiKey && copy(apiKey, "key")}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Copy"
                disabled={!apiKey}
              >
                {copiedKey ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Footer pinned to bottom */}
      <div className="mt-12 pt-6 flex items-center gap-4 text-[11px] text-muted-foreground">
        <Link to="/docs" className="hover:text-foreground transition-colors">docs</Link>
        <span className="text-muted-foreground/30">·</span>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">github</a>
        <span className="text-muted-foreground/30">·</span>
        <span className="font-mono">v{VERSION}</span>
      </div>
    </div>
  );
}

function StepPill({ num, label }: { num: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground/60">{num}</span>
      <span className="text-foreground">{label}</span>
    </span>
  );
}

export function WelcomeHeroSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-6 pt-16 pb-8">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_360px] gap-8 items-start animate-pulse">
        <div className="flex flex-col gap-6">
          <div className="h-4 w-24 bg-muted rounded" />
          <div className="flex flex-col gap-3">
            <div className="h-10 w-3/4 bg-muted rounded" />
            <div className="h-5 w-1/2 bg-muted rounded" />
          </div>
          <div className="flex gap-3">
            <div className="h-10 w-40 bg-muted rounded-lg" />
            <div className="h-10 w-32 bg-muted rounded-lg" />
          </div>
        </div>
        <div className="h-72 bg-muted rounded-xl" />
      </div>
    </div>
  );
}
