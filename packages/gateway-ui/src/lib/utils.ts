import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Extract model ID string — handles both old string format and new { id, speed? } object */
export function modelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "id" in model) return (model as { id: string }).id;
  return "";
}
