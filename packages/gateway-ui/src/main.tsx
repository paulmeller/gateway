import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initSentry, Sentry } from "./lib/sentry";
import { App } from "./App";
import "./index.css";

initSentry();

// Restore theme
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p className="p-8 text-destructive">Something went wrong. Please refresh.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
