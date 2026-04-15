/**
 * CLI-safe wrappers around ensureInitialized().
 *
 * ensureInitialized() has side effects that break CLI usage:
 * - Starts a periodic sweeper (keeps process alive)
 * - Prints API key to stdout on first boot
 * - Installs SIGINT/SIGTERM handlers
 * - Fires async orphan reconciliation that logs errors
 *
 * This module suppresses init-specific output using tagged prefix matching.
 * For one-shot commands, the caller should call process.exit(0) after completion.
 */

let initialized = false;

// Tags used by core's init.ts, sweeper.ts, and lifecycle.ts for their log output.
// We match on these exact prefixes to avoid suppressing unrelated messages.
const INIT_PREFIXES = [
  "[init]",
  "[sweeper]",
  "[shutdown]",
  "  id:",       // API key seeding prints "  id: key_..."
  "  key:",      // API key seeding prints "  key: ck_..."
];

function isInitOutput(args: unknown[]): boolean {
  const msg = String(args[0] ?? "");
  return INIT_PREFIXES.some((prefix) => msg.trimStart().startsWith(prefix));
}

export async function initForCli(): Promise<void> {
  if (initialized) return;

  const { ensureInitialized } = await import("@agentstep/agent-sdk");

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  // Suppress during init and keep suppressing for async fire-and-forget
  // operations (orphan reconciliation, sweeper) that log after init resolves
  console.log = (...args: unknown[]) => {
    if (isInitOutput(args)) return;
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (isInitOutput(args)) return;
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (isInitOutput(args)) return;
    origError(...args);
  };

  await ensureInitialized();
  initialized = true;
}
