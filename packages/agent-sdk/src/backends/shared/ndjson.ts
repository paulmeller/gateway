/**
 * NDJSON line parser for streaming CLI output (backend-agnostic).
 *
 * Returns the incomplete trailing portion so the caller can keep buffering.
 * Lifted in spirit from
 * 
 *
 * Note: the driver strips sprites.dev HTTP exec framing bytes (0x00-0x1F)
 * from the raw stream BEFORE calling this parser — this parser does not
 * mangle bytes itself.
 */
export function parseNDJSONLines(
  buffer: string,
  onLine: (parsed: Record<string, unknown>) => void,
): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      onLine(parsed);
    } catch {
      // Skip non-JSON lines (progress noise, stray log output)
    }
  }
  return remainder;
}
