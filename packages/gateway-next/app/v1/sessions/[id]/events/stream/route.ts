import { prepareSessionStream } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  const id = (await params).id;
  const prepared = await prepareSessionStream(req, id);

  if (prepared instanceof Response) return prepared;

  const { afterSeq, subscribeFn } = prepared;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const pending: Array<{ seq: number; type: string; data: string }> = [];

      const sub = subscribeFn(afterSeq, (evt) => {
        pending.push({ seq: evt.seq, type: evt.type, data: JSON.stringify(evt) });
      });

      // Drain backlog written synchronously during subscribe
      for (const evt of pending.splice(0)) {
        controller.enqueue(encoder.encode(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${evt.data}\n\n`));
      }

      // Poll for live events + keepalive
      const interval = setInterval(() => {
        for (const evt of pending.splice(0)) {
          try {
            controller.enqueue(encoder.encode(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${evt.data}\n\n`));
          } catch { /* stream closed */ }
        }
      }, 500);

      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: {"type":"ping"}\n\n`));
        } catch { /* stream closed */ }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        clearInterval(pingInterval);
        sub.unsubscribe();
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
