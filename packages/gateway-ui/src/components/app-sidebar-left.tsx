import * as React from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Home,
  Key,
  Bot,
  Server,
  MessageSquare,
  Lock,
  FileText,
  Sparkles,
  Brain,
  Play,
  BarChart3,
  BookOpen,
  Sun,
  Moon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
} from "@/components/ui/sidebar";

const VERSION = "0.3.6";

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
  exact?: boolean;
}

const OVERVIEW: NavItem[] = [
  { label: "Home", to: "/", icon: Home, exact: true },
  { label: "API Keys", to: "/api-keys", icon: Key },
];

const RESOURCES: NavItem[] = [
  { label: "Agents", to: "/agents", icon: Bot },
  { label: "Environments", to: "/environments", icon: Server },
  { label: "Sessions", to: "/sessions", icon: MessageSquare },
  { label: "Secrets", to: "/secrets", icon: Lock },
  { label: "Files", to: "/files", icon: FileText },
  { label: "Skills", to: "/skills", icon: Sparkles },
  { label: "Memory", to: "/memory", icon: Brain },
];

const TOOLS: NavItem[] = [
  { label: "Playground", to: "/playground", icon: Play },
  { label: "Analytics", to: "/dashboard", icon: BarChart3 },
  { label: "API Docs", to: "/docs", icon: BookOpen },
];

function NavGroup({ title, items }: { title: string; items: NavItem[] }) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = item.exact
            ? currentPath === item.to
            : currentPath === item.to || currentPath.startsWith(item.to + "/");

          return (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton render={<Link to={item.to} />} isActive={isActive}>
                  <Icon className="size-4" />
                  <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [dark]);

  return (
    <button
      onClick={() => {
        const isDark = document.documentElement.classList.toggle("dark");
        localStorage.setItem("theme", isDark ? "dark" : "light");
        setDark(isDark);
      }}
      className="rounded-md p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  );
}

export function AppSidebarLeft({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
                <span className="size-2.5 rounded-full bg-lime-500 shrink-0" />
                <span className="font-mono text-sm font-semibold tracking-tight">
                  agentstep
                </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavGroup title="Overview" items={OVERVIEW} />
        <NavGroup title="Resources" items={RESOURCES} />
        <NavGroup title="Tools" items={TOOLS} />
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between px-2 py-1">
          <span className="font-mono text-[11px] text-sidebar-foreground/50">
            v{VERSION}
          </span>
          <ThemeToggle />
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
