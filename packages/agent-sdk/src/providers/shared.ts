/**
 * Shared utilities for container providers.
 */

/**
 * Shell-escape a string for safe embedding in a bash command.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
