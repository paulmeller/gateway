interface Props {
  mode: "select" | "create";
  onModeChange: (mode: "select" | "create") => void;
}

export function ModeToggle({ mode, onModeChange }: Props) {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
      <button
        className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "select" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => onModeChange("select")}
      >
        Use existing
      </button>
      <button
        className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "create" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => onModeChange("create")}
      >
        Create new
      </button>
    </div>
  );
}
