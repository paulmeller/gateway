import { useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Terminal, Brain, ChevronRight } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ToolCallCard } from "./ToolCallCard";
import type { SessionEvent } from "@/hooks/use-events";

interface Props { event: SessionEvent; }

export function MessageBubble({ event }: Props) {
  const type = event.type;

  if (type === "user.message") {
    const text = extractText(event);
    return (
      <div className="flex justify-end py-1.5">
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm text-foreground">
          {text}
        </div>
      </div>
    );
  }

  if (type === "agent.message") {
    const text = extractText(event);
    return (
      <div className="py-1.5 flex gap-2.5">
        <span className="size-1.5 mt-2 shrink-0 rounded-full bg-lime-400 shadow-[0_0_4px_rgba(163,230,53,0.4)]" />
        <div className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed min-w-0">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{text}</Markdown>
        </div>
      </div>
    );
  }

  if (type === "agent.thinking") {
    return <ThinkingBlock event={event} />;
  }

  if (type === "agent.tool_use" || type === "agent.custom_tool_use") {
    const name = (event.name || event.tool_name || "tool") as string;
    const input = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {});
    return (
      <div className="py-1">
        <ToolCallCard name={name} input={input as string} />
      </div>
    );
  }

  if (type === "agent.tool_result") {
    const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "");
    return (
      <div className="py-1">
        <Accordion type="single" collapsible>
          <AccordionItem value="result" className="border rounded-lg">
            <AccordionTrigger className="px-3 py-2 text-xs hover:no-underline hover:bg-muted [&>svg]:size-3">
              <span className="flex items-center gap-2">
                <Terminal className="size-3 text-muted-foreground" />
                <span className="font-mono text-muted-foreground">Tool Result</span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="border-t bg-muted px-4 pb-3 pt-3">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
                {(content as string).slice(0, 2000)}
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    );
  }

  if (type === "session.error") {
    const err = event.error as { message?: string } | undefined;
    const msg = err?.message || "Unknown error";
    return (
      <div className="py-1.5">
        <div className="rounded-lg ring-1 ring-red-500/20 bg-red-500/[0.08] px-4 py-2.5 text-sm text-red-400">
          {msg}
        </div>
      </div>
    );
  }

  return null;
}

function ThinkingBlock({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  const text = extractText(event);
  return (
    <div className="py-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="size-3 text-muted-foreground/60" />
        <span>Thinking...</span>
        <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1.5 rounded bg-muted px-3 py-2">
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{text}</p>
        </div>
      )}
    </div>
  );
}

function extractText(event: SessionEvent): string {
  if (typeof event.text === "string") return event.text as string;
  if (Array.isArray(event.content)) {
    return (event.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("");
  }
  return "";
}
