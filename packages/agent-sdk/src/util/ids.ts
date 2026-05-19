import { ulid } from "ulid";

type Prefix = "agent" | "ver" | "env" | "sesn" | "evt" | "key" | "ukey" | "ckpt" | "span" | "trace" | "vlt" | "cred" | "memstore" | "mem" | "memver" | "file" | "sesrsc" | "tenant" | "audit" | "outc" | "sth" | "skill" | "sklv" | "work";

export function newId(prefix: Prefix): string {
  return `${prefix}_${ulid()}`;
}

export function isId(prefix: Prefix, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${prefix}_`);
}
