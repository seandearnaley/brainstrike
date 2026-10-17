import { sdkSchema } from '@brainstrike/assistant-contract/sdk-schema';
import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  ListRootsRequestSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/core';
import { Schema } from 'effect';
import { z } from 'zod';
import {
  CancelledTaskSchema,
  CompletedTaskSchema,
  FailedTaskSchema,
  type JsonObject,
  jsonObject,
  NOTIFICATION_META_SCHEMA,
  REQUEST_ID_SCHEMA,
  RESULT_META_SCHEMA,
  TaskSchema,
  WorkingTaskSchema,
} from './task.js';

const INPUT_REQUEST_VALIDATOR = sdkSchema(
  z.union([
    CreateMessageRequestSchema.catchall(z.json()),
    ListRootsRequestSchema.catchall(z.json()),
    ElicitRequestSchema.catchall(z.json()),
  ])
);
const INPUT_RESPONSE_VALIDATOR = sdkSchema(
  z.union([
    CreateMessageResultWithToolsSchema.catchall(z.json()),
    CreateMessageResultSchema.catchall(z.json()),
    ListRootsResultSchema.catchall(z.json()),
    ElicitResultSchema.catchall(z.json()),
  ])
);

export const TasksExtensionCapabilitySchema = Schema.Record(Schema.String, Schema.Never);
export const InputRequestsSchema: Schema.ConstraintDecoder<Record<string, JsonObject>> =
  Schema.Record(Schema.String, INPUT_REQUEST_VALIDATOR);
export const InputResponsesSchema: Schema.ConstraintDecoder<Record<string, JsonObject>> =
  Schema.Record(Schema.String, INPUT_RESPONSE_VALIDATOR);

export const InputRequiredTaskSchema = jsonObject({
  ...TaskSchema.schema.fields,
  inputRequests: InputRequestsSchema,
  status: Schema.Literal('input_required'),
});
export const DetailedTaskSchema = Schema.Union(
  [
    WorkingTaskSchema,
    InputRequiredTaskSchema,
    CompletedTaskSchema,
    FailedTaskSchema,
    CancelledTaskSchema,
  ],
  { mode: 'oneOf' }
);

export const GetTaskParamsSchema = jsonObject({ taskId: Schema.String });
export const GetTaskResultSchema = Schema.Union(
  [
    jsonObject({
      ...WorkingTaskSchema.schema.fields,
      _meta: RESULT_META_SCHEMA,
      resultType: Schema.Literal('complete'),
    }),
    jsonObject({
      ...InputRequiredTaskSchema.schema.fields,
      _meta: RESULT_META_SCHEMA,
      resultType: Schema.Literal('complete'),
    }),
    jsonObject({
      ...CompletedTaskSchema.schema.fields,
      _meta: RESULT_META_SCHEMA,
      resultType: Schema.Literal('complete'),
    }),
    jsonObject({
      ...FailedTaskSchema.schema.fields,
      _meta: RESULT_META_SCHEMA,
      resultType: Schema.Literal('complete'),
    }),
    jsonObject({
      ...CancelledTaskSchema.schema.fields,
      _meta: RESULT_META_SCHEMA,
      resultType: Schema.Literal('complete'),
    }),
  ],
  { mode: 'oneOf' }
);
export const UpdateTaskParamsSchema = jsonObject({
  inputResponses: InputResponsesSchema,
  taskId: Schema.String,
});
export const UpdateTaskResultSchema = jsonObject({
  _meta: RESULT_META_SCHEMA,
  resultType: Schema.Literal('complete'),
});
export const CancelTaskParamsSchema = GetTaskParamsSchema;
export const CancelTaskResultSchema = UpdateTaskResultSchema;
export const TaskStatusNotificationParamsSchema = Schema.Union(
  [
    jsonObject({ ...WorkingTaskSchema.schema.fields, _meta: NOTIFICATION_META_SCHEMA }),
    jsonObject({ ...InputRequiredTaskSchema.schema.fields, _meta: NOTIFICATION_META_SCHEMA }),
    jsonObject({ ...CompletedTaskSchema.schema.fields, _meta: NOTIFICATION_META_SCHEMA }),
    jsonObject({ ...FailedTaskSchema.schema.fields, _meta: NOTIFICATION_META_SCHEMA }),
    jsonObject({ ...CancelledTaskSchema.schema.fields, _meta: NOTIFICATION_META_SCHEMA }),
  ],
  { mode: 'oneOf' }
);
export const TaskSubscriptionNotificationsSchema = jsonObject({
  taskIds: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
});
export const TaskSubscriptionAcknowledgedNotificationsSchema = TaskSubscriptionNotificationsSchema;

const JSONRPC_REQUEST_SHAPE = {
  id: REQUEST_ID_SCHEMA,
  jsonrpc: Schema.Literal('2.0'),
} as const;

export const GetTaskRequestSchema = jsonObject({
  ...JSONRPC_REQUEST_SHAPE,
  method: Schema.Literal('tasks/get'),
  params: GetTaskParamsSchema,
});
export const UpdateTaskRequestSchema = jsonObject({
  ...JSONRPC_REQUEST_SHAPE,
  method: Schema.Literal('tasks/update'),
  params: UpdateTaskParamsSchema,
});
export const CancelTaskRequestSchema = jsonObject({
  ...JSONRPC_REQUEST_SHAPE,
  method: Schema.Literal('tasks/cancel'),
  params: CancelTaskParamsSchema,
});
export const TaskStatusNotificationSchema = jsonObject({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.Literal('notifications/tasks'),
  params: TaskStatusNotificationParamsSchema,
});

export type TasksExtensionCapability = (typeof TasksExtensionCapabilitySchema)['Type'];
export type InputRequiredTask = (typeof InputRequiredTaskSchema)['Type'];
export type DetailedTask = (typeof DetailedTaskSchema)['Type'];
export type GetTaskParams = (typeof GetTaskParamsSchema)['Type'];
export type GetTaskResult = (typeof GetTaskResultSchema)['Type'];
export type UpdateTaskParams = (typeof UpdateTaskParamsSchema)['Type'];
export type UpdateTaskResult = (typeof UpdateTaskResultSchema)['Type'];
export type CancelTaskParams = (typeof CancelTaskParamsSchema)['Type'];
export type CancelTaskResult = (typeof CancelTaskResultSchema)['Type'];
export type TaskStatusNotificationParams = (typeof TaskStatusNotificationParamsSchema)['Type'];
export type TaskSubscriptionNotifications = (typeof TaskSubscriptionNotificationsSchema)['Type'];
export type TaskSubscriptionAcknowledgedNotifications =
  (typeof TaskSubscriptionAcknowledgedNotificationsSchema)['Type'];
export type GetTaskRequest = (typeof GetTaskRequestSchema)['Type'];
export type UpdateTaskRequest = (typeof UpdateTaskRequestSchema)['Type'];
export type CancelTaskRequest = (typeof CancelTaskRequestSchema)['Type'];
export type TaskStatusNotification = (typeof TaskStatusNotificationSchema)['Type'];

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
} from './task.js';
