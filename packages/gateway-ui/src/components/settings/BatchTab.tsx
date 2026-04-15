import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "./PageHeader";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

const EXAMPLE = JSON.stringify({
  operations: [
    { method: "GET", path: "/v1/agents" },
    { method: "GET", path: "/v1/environments" },
  ]
}, null, 2);

export function BatchTab() {
  const [input, setInput] = useState(EXAMPLE);
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleExecute() {
    setLoading(true);
    setResult("");
    try {
      const body = JSON.parse(input);
      const res = await api<unknown>("/batch", { method: "POST", body: JSON.stringify(body) });
      setResult(JSON.stringify(res, null, 2));
      toast.success("Batch executed");
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        toast.error("Invalid JSON");
      } else {
        const apiErr = err as { body?: { error?: { message?: string } } };
        const msg = apiErr?.body?.error?.message || (err instanceof Error ? err.message : "Batch failed");
        toast.error(msg);
        setResult(JSON.stringify(apiErr?.body ?? msg, null, 2));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Batch operations"
        description="Execute multiple API operations in a single request."
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Request</p>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="min-h-[200px] w-full font-mono text-xs text-foreground"
            placeholder='{"operations": [...]}'
          />
        </div>

        <Button
          className="w-fit bg-cta-gradient text-black hover:opacity-90"
          onClick={handleExecute}
          disabled={loading}
        >
          {loading ? "Executing..." : "Execute batch"}
        </Button>

        {result && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">Response</p>
            <pre className="rounded-lg border bg-muted p-4 font-mono text-xs text-muted-foreground overflow-auto max-h-[400px] whitespace-pre-wrap break-all">
              {result}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
