import { ulid } from "ulid";

type Prefix = "agent" | "ver" | "env" | "sess" | "evt" | "key" | "ukey" | "ckpt" | "span" | "trace" | "vault" | "vcrd" | "ms" | "mem" | "file" | "sesrsc" | "tenant" | "audit";

export function newId(prefix: Prefix): string {
  return `${prefix}_${ulid()}`;
}

export function isId(prefix: Prefix, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${prefix}_`);
}
