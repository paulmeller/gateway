import * as React from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Home,
  Key,
  Building2,
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
import { useWhoami } from "@/hooks/use-whoami";
import { useLicense } from "@/hooks/use-license";

const VERSION = "0.4.11";

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
  exact?: boolean;
}

const OVERVIEW_BASE: NavItem[] = [
  { label: "Home", to: "/", icon: Home, exact: true },
  { label: "API Keys", to: "/api-keys", icon: Key },
];

const TENANTS_ITEM: NavItem = { label: "Tenants", to: "/tenants", icon: Building2 };

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

/**
 * Overview nav; shows Tenants entry only when the feature is enabled
 * (in the license) AND the caller is a global admin.
 */
function OverviewNav() {
  const { data: me } = useWhoami();
  const { data: lic } = useLicense();
  const tenancyEnabled = lic?.features.includes("tenancy");
  const items = me?.is_global_admin && tenancyEnabled
    ? [...OVERVIEW_BASE, TENANTS_ITEM]
    : OVERVIEW_BASE;
  return <NavGroup title="Overview" items={items} />;
}

/**
 * Footer row surfacing which tenant context the caller operates in.
 * Global admins see "(global)"; tenant users see their tenant id.
 * Helps avoid the "why am I not seeing X" confusion when a key is
 * scoped to a single tenant.
 */
function TenantContextRow() {
  const { data: me } = useWhoami();
  if (!me) return null;
  const label = me.is_global_admin
    ? "global"
    : me.tenant_id ?? "unscoped";
  return (
    <div className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-[11px] text-sidebar-foreground/60">
      <Building2 className="size-3" />
      <span className="truncate font-mono">{label}</span>
    </div>
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
        <OverviewNav />
        <NavGroup title="Resources" items={RESOURCES} />
        <NavGroup title="Tools" items={TOOLS} />
      </SidebarContent>

      <SidebarFooter>
        <TenantContextRow />
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
