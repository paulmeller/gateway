/**
 * Singleton OpenAPIRegistry shared across the schema module and the spec
 * builder. Kept in its own file so `schemas.ts` and `spec.ts` can both
 * import it without a circular dependency.
 */
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

export const registry = new OpenAPIRegistry();
