import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { executeBatch, BatchError } from "../db/batch";
import { badRequest } from "../errors";

const OperationSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  body: z.record(z.unknown()).optional(),
});

const BatchSchema = z.object({
  operations: z.array(OperationSchema).min(1).max(50),
});

export function handleBatch(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json();
    const parsed = BatchSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    try {
      const results = executeBatch(parsed.data.operations);
      return jsonOk({ results });
    } catch (err) {
      if (err instanceof BatchError) {
        return jsonOk(
          {
            error: {
              type: "batch_error",
              message: err.message,
              failed_operation_index: err.failedIndex,
            },
          },
          400,
        );
      }
      throw err;
    }
  });
}
