import { useEffect, useState } from "react";

const STAGES = [
  "Creating session...",
  "Waiting for user...",
];

export function BootProgress() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setStage(1), 2000),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="flex flex-col gap-2 py-6">
      {STAGES.map((label, i) => (
        <div
          key={label}
          className={`flex items-center gap-2.5 transition-opacity duration-300 ${
            i > stage ? "opacity-0" : i === stage ? "opacity-100" : "opacity-40"
          }`}
        >
          {i < stage ? (
            <span className="size-2 rounded-full bg-lime-400/40" />
          ) : i === stage ? (
            <span className="size-2 rounded-full bg-lime-400 animate-pulse shadow-[0_0_6px_rgba(163,230,53,0.6)]" />
          ) : (
            <span className="size-2 rounded-full bg-muted-foreground/20" />
          )}
          <span className={`text-xs font-mono ${i === stage ? "text-foreground" : "text-muted-foreground"}`}>
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
