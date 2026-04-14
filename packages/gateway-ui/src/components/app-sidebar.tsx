import * as React from "react";
import { useState } from "react";
import { Settings, Plus, Eye, EyeOff, Sun, Moon, ExternalLink, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SessionList } from "@/components/sessions/SessionList";
import { useAppStore } from "@/stores/app-store";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarGroup,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { apiKey, setApiKey, setSettingsOpen, setActiveSessionId } = useAppStore();
  const [showKey, setShowKey] = useState(false);

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/">
                <div className="size-8 rounded-full bg-cta-gradient" />
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">AgentStep</span>
                  <span className="text-xs">Gateway</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            <span className="flex-1">Sessions</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              onClick={() => setActiveSessionId(null)}
            >
              <Plus className="size-3.5" />
            </Button>
          </SidebarGroupLabel>
          <SessionList />
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="p-1 flex flex-col gap-2">
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              placeholder="API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-8 pr-8 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 size-8"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            </Button>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <a href="https://www.agentstep.com" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <ExternalLink className="size-3" /> agentstep.com
            </a>
            <span className="text-muted-foreground/30">·</span>
            <a href="https://www.agentstep.com/docs" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <BookOpen className="size-3" /> Docs
            </a>
            {window.__MA_VERSION__ && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="text-muted-foreground/50">v{window.__MA_VERSION__}</span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 justify-start gap-2 text-xs"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-3.5" />
              Settings
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => {
                document.documentElement.classList.toggle("dark");
              }}
            >
              <Sun className="size-3.5 rotate-0 scale-100 transition-transform dark:rotate-90 dark:scale-0" />
              <Moon className="absolute size-3.5 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
