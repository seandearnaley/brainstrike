// Preconversion Zod oracle; test-only, never a production task producer.
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
import {
  CancelledTaskSchema,
  CompletedTaskSchema,
  FailedTaskSchema,
  JSON_VALUE_SCHEMA,
  type JsonObject,
  NOTIFICATION_META_SCHEMA,
  REQUEST_ID_SCHEMA,
  RESULT_META_SCHEMA,
  TaskSchema,
  WorkingTaskSchema,
} from './pre-effect-task.js';

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
export const InputRequestsSchema: z.ZodType<Record<string, JsonObject>> = z.record(
  z.string(),
  INPUT_REQUEST_VALIDATOR
);
export const InputResponsesSchema: z.ZodType<Record<string, JsonObject>> = z.record(
  z.string(),
  INPUT_RESPONSE_VALIDATOR
);

export const InputRequiredTaskSchema = TaskSchema.extend({
  inputRequests: InputRequestsSchema,
  status: z.literal('input_required'),
});
export const DetailedTaskSchema = z.discriminatedUnion('status', [
  WorkingTaskSchema,
  InputRequiredTaskSchema,
  CompletedTaskSchema,
  FailedTaskSchema,
  CancelledTaskSchema,
]);

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
export type InputRequiredTask = z.infer<typeof InputRequiredTaskSchema>;
export type DetailedTask = z.infer<typeof DetailedTaskSchema>;
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

export {
  type CancelledTask,
  CancelledTaskSchema,
  type CompletedTask,
  CompletedTaskSchema,
  type CreateTaskResult,
  CreateTaskResultSchema,
  type FailedTask,
  FailedTaskSchema,
  type Task,
  TaskSchema,
  type TaskStatus,
  TaskStatusSchema,
  type WorkingTask,
  WorkingTaskSchema,
} from './pre-effect-task.js';
