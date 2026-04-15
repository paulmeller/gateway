import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { snippetRegistry, interpolate, type SnippetLang } from "@/lib/code-snippets";
import { toast } from "sonner";

interface Props {
  resource: string;
  resourceId?: string;
  resourceName?: string;
}

const LANGS: { key: SnippetLang; label: string }[] = [
  { key: "curl", label: "cURL" },
  { key: "python", label: "Python" },
  { key: "typescript", label: "TypeScript" },
];

function CodeBlock({ code, lang }: { code: string; lang: SnippetLang }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative group">
      <pre className="bg-muted rounded p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-6 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
        title="Copy code"
      >
        {copied ? (
          <Check className="size-3 text-lime-400" />
        ) : (
          <Copy className="size-3 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
}

export function CodeSnippetPanel({ resource, resourceId, resourceName }: Props) {
  const snippets = snippetRegistry[resource];

  if (!snippets) {
    return (
      <div className="w-80 border-l border-border bg-card flex items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">No snippets available.</p>
      </div>
    );
  }

  const hasId = Boolean(resourceId);

  // Sections to show — list always shown; get/update/delete shown when we have an ID
  const sections: { label: string; key: keyof typeof snippets }[] = [
    { label: "List", key: "list" },
    ...(hasId && snippets.get ? [{ label: "Get", key: "get" as const }] : []),
    ...(hasId && snippets.update ? [{ label: "Update", key: "update" as const }] : []),
    ...(hasId && snippets.delete ? [{ label: "Delete", key: "delete" as const }] : []),
  ];

  return (
    <div className="w-80 border-l border-border bg-card flex flex-col">
      {/* Panel header */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Code Examples</p>
        {resourceName && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{resourceName}</p>
        )}
      </div>

      {/* Tab-per-language */}
      <Tabs defaultValue="curl" className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 pt-3">
          <TabsList className="w-full">
            {LANGS.map(({ key, label }) => (
              <TabsTrigger key={key} value={key} className="flex-1 text-xs">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {LANGS.map(({ key }) => (
          <TabsContent key={key} value={key} className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-4 mt-3">
            {sections.map(({ label, key: sectionKey }) => {
              const section = snippets[sectionKey];
              if (!section) return null;
              const raw = section[key];
              const code = resourceId ? interpolate(raw, resourceId) : raw;
              return (
                <div key={sectionKey} className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">{label}</p>
                  <CodeBlock code={code} lang={key} />
                </div>
              );
            })}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
