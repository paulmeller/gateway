import { Link } from "@tanstack/react-router";
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

const VERSION = "0.2.12";

interface NavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
}

const OVERVIEW: NavItem[] = [
  { label: "Home", to: "/", icon: <Home className="size-4" /> },
  { label: "API Keys", to: "/api-keys", icon: <Key className="size-4" /> },
];

const RESOURCES: NavItem[] = [
  { label: "Agents", to: "/agents", icon: <Bot className="size-4" /> },
  { label: "Environments", to: "/environments", icon: <Server className="size-4" /> },
  { label: "Sessions", to: "/sessions", icon: <MessageSquare className="size-4" /> },
  { label: "Secrets", to: "/secrets", icon: <Lock className="size-4" /> },
  { label: "Files", to: "/files", icon: <FileText className="size-4" /> },
  { label: "Skills", to: "/skills", icon: <Sparkles className="size-4" /> },
  { label: "Memory", to: "/memory", icon: <Brain className="size-4" /> },
];

const TOOLS: NavItem[] = [
  { label: "Playground", to: "/playground", icon: <Play className="size-4" /> },
  { label: "Dashboard", to: "/dashboard", icon: <BarChart3 className="size-4" /> },
  { label: "API Docs", to: "/docs", icon: <BookOpen className="size-4" /> },
];

function NavSection({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <div className="mb-4">
      <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              activeProps={{ className: "bg-lime-500/15 text-lime-600 dark:text-lime-400 font-medium hover:bg-lime-500/20 hover:text-lime-600 dark:hover:text-lime-400" }}
              activeOptions={{ exact: item.to === "/" }}
            >
              {item.icon}
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
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
      onClick={() => setDark((d) => !d)}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  );
}

export function ConsoleNav() {
  return (
    <aside className="flex h-screen w-56 flex-col border-r bg-card">
      {/* Logo */}
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <span className="size-2.5 rounded-full bg-lime-500" />
        <span className="font-mono text-sm font-semibold tracking-tight">agentstep</span>
      </div>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        <NavSection title="Overview" items={OVERVIEW} />
        <NavSection title="Resources" items={RESOURCES} />
        <NavSection title="Tools" items={TOOLS} />
      </nav>

      {/* Footer */}
      <div className="flex items-center justify-between border-t px-4 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">v{VERSION}</span>
        <ThemeToggle />
      </div>
    </aside>
  );
}
