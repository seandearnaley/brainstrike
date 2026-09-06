import {
  type CancelTaskParams,
  CancelTaskParamsSchema,
  type CancelTaskResult,
  CancelTaskResultSchema,
  type GetTaskParams,
  GetTaskParamsSchema,
  type GetTaskResult,
  GetTaskResultSchema,
  type TaskStatusNotificationParams,
  TaskStatusNotificationParamsSchema,
  type TaskSubscriptionAcknowledgedNotifications,
  TaskSubscriptionAcknowledgedNotificationsSchema,
  type TaskSubscriptionNotifications,
  TaskSubscriptionNotificationsSchema,
  type UpdateTaskParams,
  UpdateTaskParamsSchema,
  type UpdateTaskResult,
  UpdateTaskResultSchema,
} from './schema.js';

export { parseMcpCreateTaskResult } from './task.js';

export function parseMcpGetTaskParams(value: unknown): GetTaskParams {
  return GetTaskParamsSchema.parse(value);
}

export function parseMcpGetTaskResult(value: unknown): GetTaskResult {
  return GetTaskResultSchema.parse(value);
}

export function parseMcpUpdateTaskParams(value: unknown): UpdateTaskParams {
  return UpdateTaskParamsSchema.parse(value);
}

export function parseMcpUpdateTaskResult(value: unknown): UpdateTaskResult {
  return UpdateTaskResultSchema.parse(value);
}

export function parseMcpCancelTaskParams(value: unknown): CancelTaskParams {
  return CancelTaskParamsSchema.parse(value);
}

export function parseMcpCancelTaskResult(value: unknown): CancelTaskResult {
  return CancelTaskResultSchema.parse(value);
}

export function parseMcpTaskStatusNotificationParams(value: unknown): TaskStatusNotificationParams {
  return TaskStatusNotificationParamsSchema.parse(value);
}

export function parseMcpTaskSubscriptionNotifications(
  value: unknown
): TaskSubscriptionNotifications {
  return TaskSubscriptionNotificationsSchema.parse(value);
}

export function parseMcpTaskSubscriptionAcknowledgedNotifications(
  value: unknown
): TaskSubscriptionAcknowledgedNotifications {
  return TaskSubscriptionAcknowledgedNotificationsSchema.parse(value);
}
