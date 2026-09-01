import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  ListRootsRequestSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/core';
import { z } from 'zod';

const REQUEST_ID_SCHEMA = z.union([z.string(), z.number().int()]);
type JsonValue = boolean | null | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}
const JSON_VALUE_SCHEMA: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(JSON_VALUE_SCHEMA),
    z.record(z.string(), JSON_VALUE_SCHEMA),
  ])
);
const JSON_OBJECT_SCHEMA: z.ZodType<JsonObject> = z.record(z.string(), JSON_VALUE_SCHEMA);
const SAFE_INTEGER_SCHEMA = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

const RESULT_META_SCHEMA = JSON_OBJECT_SCHEMA.optional();
const NOTIFICATION_META_SCHEMA = JSON_OBJECT_SCHEMA.optional();
const INPUT_REQUEST_VALIDATOR = z.union([
  CreateMessageRequestSchema.catchall(JSON_VALUE_SCHEMA),
  ListRootsRequestSchema.catchall(JSON_VALUE_SCHEMA),
  ElicitRequestSchema.catchall(JSON_VALUE_SCHEMA),
]);
const INPUT_RESPONSE_VALIDATOR = z.union([
  CreateMessageResultWithToolsSchema.catchall(JSON_VALUE_SCHEMA),
  CreateMessageResultSchema.catchall(JSON_VALUE_SCHEMA),
  ListRootsResultSchema.catchall(JSON_VALUE_SCHEMA),
  ElicitResultSchema.catchall(JSON_VALUE_SCHEMA),
]);

export const TasksExtensionCapabilitySchema = z.strictObject({});
export const TaskStatusSchema = z.enum([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);
export const InputRequestsSchema: z.ZodType<Record<string, JsonObject>> = z.record(
  z.string(),
  INPUT_REQUEST_VALIDATOR
);
export const InputResponsesSchema: z.ZodType<Record<string, JsonObject>> = z.record(
  z.string(),
  INPUT_RESPONSE_VALIDATOR
);

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
export const InputRequiredTaskSchema = TaskSchema.extend({
  inputRequests: InputRequestsSchema,
  status: z.literal('input_required'),
});
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
export const DetailedTaskSchema = z.discriminatedUnion('status', [
  WorkingTaskSchema,
  InputRequiredTaskSchema,
  CompletedTaskSchema,
  FailedTaskSchema,
  CancelledTaskSchema,
]);

// Canonical CreateTaskResult is Result & Task, not Result & DetailedTask.
export const CreateTaskResultSchema = TaskSchema.extend({
  _meta: RESULT_META_SCHEMA,
  resultType: z.literal('task'),
});
export const GetTaskParamsSchema = z.object({ taskId: z.string() }).catchall(JSON_VALUE_SCHEMA);
export const GetTaskResultSchema = z.discriminatedUnion('status', [
  WorkingTaskSchema.extend({ _meta: RESULT_META_SCHEMA, resultType: z.literal('complete') }),
  InputRequiredTaskSchema.extend({
    _meta: RESULT_META_SCHEMA,
    resultType: z.literal('complete'),
  }),
  CompletedTaskSchema.extend({ _meta: RESULT_META_SCHEMA, resultType: z.literal('complete') }),
  FailedTaskSchema.extend({ _meta: RESULT_META_SCHEMA, resultType: z.literal('complete') }),
  CancelledTaskSchema.extend({ _meta: RESULT_META_SCHEMA, resultType: z.literal('complete') }),
]);
export const UpdateTaskParamsSchema = z
  .object({ inputResponses: InputResponsesSchema, taskId: z.string() })
  .catchall(JSON_VALUE_SCHEMA);
export const UpdateTaskResultSchema = z
  .object({ _meta: RESULT_META_SCHEMA, resultType: z.literal('complete') })
  .catchall(JSON_VALUE_SCHEMA);
export const CancelTaskParamsSchema = GetTaskParamsSchema;
export const CancelTaskResultSchema = UpdateTaskResultSchema;
export const TaskStatusNotificationParamsSchema = z.discriminatedUnion('status', [
  WorkingTaskSchema.extend({ _meta: NOTIFICATION_META_SCHEMA }),
  InputRequiredTaskSchema.extend({ _meta: NOTIFICATION_META_SCHEMA }),
  CompletedTaskSchema.extend({ _meta: NOTIFICATION_META_SCHEMA }),
  FailedTaskSchema.extend({ _meta: NOTIFICATION_META_SCHEMA }),
  CancelledTaskSchema.extend({ _meta: NOTIFICATION_META_SCHEMA }),
]);
export const TaskSubscriptionNotificationsSchema = z
  .object({ taskIds: z.array(z.string()).optional() })
  .catchall(JSON_VALUE_SCHEMA);
export const TaskSubscriptionAcknowledgedNotificationsSchema = TaskSubscriptionNotificationsSchema;

const JSONRPC_REQUEST_SHAPE = {
  id: REQUEST_ID_SCHEMA,
  jsonrpc: z.literal('2.0'),
} as const;

export const GetTaskRequestSchema = z
  .object({ ...JSONRPC_REQUEST_SHAPE, method: z.literal('tasks/get'), params: GetTaskParamsSchema })
  .catchall(JSON_VALUE_SCHEMA);
export const UpdateTaskRequestSchema = z
  .object({
    ...JSONRPC_REQUEST_SHAPE,
    method: z.literal('tasks/update'),
    params: UpdateTaskParamsSchema,
  })
  .catchall(JSON_VALUE_SCHEMA);
export const CancelTaskRequestSchema = z
  .object({
    ...JSONRPC_REQUEST_SHAPE,
    method: z.literal('tasks/cancel'),
    params: CancelTaskParamsSchema,
  })
  .catchall(JSON_VALUE_SCHEMA);
export const TaskStatusNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('notifications/tasks'),
    params: TaskStatusNotificationParamsSchema,
  })
  .catchall(JSON_VALUE_SCHEMA);

export type TasksExtensionCapability = z.infer<typeof TasksExtensionCapabilitySchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type WorkingTask = z.infer<typeof WorkingTaskSchema>;
export type InputRequiredTask = z.infer<typeof InputRequiredTaskSchema>;
export type CompletedTask = z.infer<typeof CompletedTaskSchema>;
export type FailedTask = z.infer<typeof FailedTaskSchema>;
export type CancelledTask = z.infer<typeof CancelledTaskSchema>;
export type DetailedTask = z.infer<typeof DetailedTaskSchema>;
export type CreateTaskResult = z.infer<typeof CreateTaskResultSchema>;
export type GetTaskParams = z.infer<typeof GetTaskParamsSchema>;
export type GetTaskResult = z.infer<typeof GetTaskResultSchema>;
export type UpdateTaskParams = z.infer<typeof UpdateTaskParamsSchema>;
export type UpdateTaskResult = z.infer<typeof UpdateTaskResultSchema>;
export type CancelTaskParams = z.infer<typeof CancelTaskParamsSchema>;
export type CancelTaskResult = z.infer<typeof CancelTaskResultSchema>;
export type TaskStatusNotificationParams = z.infer<typeof TaskStatusNotificationParamsSchema>;
export type TaskSubscriptionNotifications = z.infer<typeof TaskSubscriptionNotificationsSchema>;
export type TaskSubscriptionAcknowledgedNotifications = z.infer<
  typeof TaskSubscriptionAcknowledgedNotificationsSchema
>;
export type GetTaskRequest = z.infer<typeof GetTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type CancelTaskRequest = z.infer<typeof CancelTaskRequestSchema>;
export type TaskStatusNotification = z.infer<typeof TaskStatusNotificationSchema>;
