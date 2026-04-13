import { useEffect } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useAppStore } from "@/stores/app-store";
import { useSessions } from "@/hooks/use-sessions";
import { Settings, Bug, MessageSquare } from "lucide-react";

export function CommandPalette() {
  const { commandOpen, setCommandOpen, setActiveSessionId, setSettingsOpen, toggleDebug } = useAppStore();
  const { data: sessions } = useSessions();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setCommandOpen(!commandOpen); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [commandOpen, setCommandOpen]);

  function select(fn: () => void) { fn(); setCommandOpen(false); }

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder="Search sessions, actions..." className="text-sm" />
      <CommandList>
        <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => select(() => setSettingsOpen(true))} className="gap-2">
            <Settings className="size-3.5 text-muted-foreground" />
            Open Settings
          </CommandItem>
          <CommandItem onSelect={() => select(toggleDebug)} className="gap-2">
            <Bug className="size-3.5 text-muted-foreground" />
            Toggle Debug Panel
          </CommandItem>
        </CommandGroup>
        {sessions && sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {sessions.slice(0, 10).map((s) => (
              <CommandItem key={s.id} onSelect={() => select(() => setActiveSessionId(s.id))} className="gap-2">
                <MessageSquare className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{s.title || s.id.slice(0, 12)}</span>
                <span className="font-mono text-xs text-muted-foreground/50">{s.status}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
