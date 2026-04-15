import { ulid } from "ulid";

type Prefix = "agent" | "ver" | "env" | "sess" | "evt" | "key" | "ckpt" | "span" | "trace" | "vault" | "ms" | "mem" | "file";

export function newId(prefix: Prefix): string {
  return `${prefix}_${ulid()}`;
}

export function isId(prefix: Prefix, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${prefix}_`);
}
