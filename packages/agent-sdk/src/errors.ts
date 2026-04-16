/**
 * Managed Agents error envelope + typed HTTP error responses.
 *
 * Shape:
 *   { "type": "error", "error": { "type": "...", "message": "..." } }
 *
 * Uses Web Standard Response — no framework dependency.
 */

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_busy"
  | "server_error";

export class ApiError extends Error {
  constructor(
    public status: number,
    public type: ErrorType,
    message: string,
  ) {
    super(message);
  }
}

export function envelope(type: ErrorType, message: string) {
  return { type: "error", error: { type, message } };
}

export function toResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(envelope(err.type, err.message), { status: err.status });
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[error] unhandled:", msg);
  return Response.json(envelope("server_error", "internal server error"), { status: 500 });
}

// Convenience constructors

export const badRequest = (msg: string) => new ApiError(400, "invalid_request_error", msg);
export const unauthorized = (msg = "missing or invalid API key") =>
  new ApiError(401, "authentication_error", msg);
export const forbidden = (msg: string) => new ApiError(403, "permission_error", msg);
export const notFound = (msg: string) => new ApiError(404, "not_found_error", msg);
export const conflict = (msg: string) => new ApiError(409, "invalid_request_error", msg);
export const tooManyRequests = (msg = "rate limit exceeded") =>
  new ApiError(429, "rate_limit_error", msg);
export const serverBusy = (msg = "server is at capacity") =>
  new ApiError(503, "server_busy", msg);
