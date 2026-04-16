import { Wrench } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface Props { name: string; input: string; result?: string; }

export function ToolCallCard({ name, input, result }: Props) {
  return (
    <Accordion>
      <AccordionItem value="tool" className="border rounded-lg">
        <AccordionTrigger className="px-3 py-2 text-xs hover:no-underline hover:bg-muted [&>svg]:size-3">
          <span className="flex items-center gap-2">
            <Wrench className="size-3 text-lime-400/60" />
            <span className="font-mono text-muted-foreground">{name}</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="border-t bg-muted px-4 pb-3 pt-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Input</p>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
            {formatJson(input)}
          </pre>
          {result && (
            <>
              <p className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Output</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
                {formatJson(result)}
              </pre>
            </>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function formatJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
