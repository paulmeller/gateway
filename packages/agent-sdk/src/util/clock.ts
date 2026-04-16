export function nowMs(): number {
  return Date.now();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
