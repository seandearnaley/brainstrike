// Preconversion Zod oracle; test-only, never a production task producer.
import { z } from 'zod';

/**
 * Core-free task schemas: no `@modelcontextprotocol/core` import, so a tool
 * path that only needs to recognise a created task can bundle this module
 * into MCP-free outputs. `schema.ts` layers the input-request / response
 * validators (which need core) on top and re-exports everything here.
 */
export type JsonValue = boolean | null | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const REQUEST_ID_SCHEMA = z.union([z.string(), z.number().int()]);
export const JSON_VALUE_SCHEMA: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(JSON_VALUE_SCHEMA),
    z.record(z.string(), JSON_VALUE_SCHEMA),
  ])
);
export const JSON_OBJECT_SCHEMA: z.ZodType<JsonObject> = z.record(z.string(), JSON_VALUE_SCHEMA);
export const SAFE_INTEGER_SCHEMA = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const RESULT_META_SCHEMA = JSON_OBJECT_SCHEMA.optional();
export const NOTIFICATION_META_SCHEMA = JSON_OBJECT_SCHEMA.optional();

export const TaskStatusSchema = z.enum([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);

const TASK_SHAPE = {
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  // The canonical ext-tasks schema permits the full signed safe-integer range.
  pollIntervalMs: SAFE_INTEGER_SCHEMA.optional(),
  status: TaskStatusSchema,
  statusMessage: z.string().optional(),
  taskId: z.string(),
  ttlMs: SAFE_INTEGER_SCHEMA.nullable(),
} as const;

export const TaskSchema = z.object(TASK_SHAPE).catchall(JSON_VALUE_SCHEMA);
export const WorkingTaskSchema = TaskSchema.extend({ status: z.literal('working') });
export const CompletedTaskSchema = TaskSchema.extend({
  result: JSON_OBJECT_SCHEMA,
  status: z.literal('completed'),
});
export const FailedTaskSchema = TaskSchema.extend({
  error: z
    .object({ code: SAFE_INTEGER_SCHEMA, data: JSON_VALUE_SCHEMA.optional(), message: z.string() })
    .catchall(JSON_VALUE_SCHEMA),
  status: z.literal('failed'),
});
export const CancelledTaskSchema = TaskSchema.extend({ status: z.literal('cancelled') });

// Canonical CreateTaskResult is Result & Task, not Result & DetailedTask.
export const CreateTaskResultSchema = TaskSchema.extend({
  _meta: RESULT_META_SCHEMA,
  resultType: z.literal('task'),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type WorkingTask = z.infer<typeof WorkingTaskSchema>;
export type CompletedTask = z.infer<typeof CompletedTaskSchema>;
export type FailedTask = z.infer<typeof FailedTaskSchema>;
export type CancelledTask = z.infer<typeof CancelledTaskSchema>;
export type CreateTaskResult = z.infer<typeof CreateTaskResultSchema>;

export function parseMcpCreateTaskResult(value: unknown): CreateTaskResult {
  return CreateTaskResultSchema.parse(value);
}
