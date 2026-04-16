import { useRef, useCallback } from "react";
import { EventStream } from "@/components/events/EventStream";

interface Props { defaultHeight?: number; }

export function DebugPanel({ defaultHeight = 250 }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback(() => {
    dragging.current = true;
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !panelRef.current) return;
      const parentRect = panelRef.current.parentElement?.getBoundingClientRect();
      if (!parentRect) return;
      const newHeight = parentRect.bottom - e.clientY;
      const clamped = Math.max(100, Math.min(newHeight, parentRect.height - 100));
      panelRef.current.style.height = `${clamped}px`;
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={panelRef} className="border-t border-border bg-muted" style={{ height: defaultHeight }}>
      <div
        className="flex h-1.5 cursor-row-resize items-center justify-center hover:bg-muted"
        onMouseDown={onMouseDown}
      >
        <div className="h-[1px] w-8 rounded-full bg-border" />
      </div>
      <div className="h-[calc(100%-6px)] overflow-hidden">
        <EventStream />
      </div>
    </div>
  );
}
