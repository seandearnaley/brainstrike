import { Schema } from 'effect';
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
  return Schema.decodeUnknownSync(GetTaskParamsSchema)(value);
}

export function parseMcpGetTaskResult(value: unknown): GetTaskResult {
  return Schema.decodeUnknownSync(GetTaskResultSchema)(value);
}

export function parseMcpUpdateTaskParams(value: unknown): UpdateTaskParams {
  return Schema.decodeUnknownSync(UpdateTaskParamsSchema)(value);
}

export function parseMcpUpdateTaskResult(value: unknown): UpdateTaskResult {
  return Schema.decodeUnknownSync(UpdateTaskResultSchema)(value);
}

export function parseMcpCancelTaskParams(value: unknown): CancelTaskParams {
  return Schema.decodeUnknownSync(CancelTaskParamsSchema)(value);
}

export function parseMcpCancelTaskResult(value: unknown): CancelTaskResult {
  return Schema.decodeUnknownSync(CancelTaskResultSchema)(value);
}

export function parseMcpTaskStatusNotificationParams(value: unknown): TaskStatusNotificationParams {
  return Schema.decodeUnknownSync(TaskStatusNotificationParamsSchema)(value);
}

export function parseMcpTaskSubscriptionNotifications(
  value: unknown
): TaskSubscriptionNotifications {
  return Schema.decodeUnknownSync(TaskSubscriptionNotificationsSchema)(value);
}

export function parseMcpTaskSubscriptionAcknowledgedNotifications(
  value: unknown
): TaskSubscriptionAcknowledgedNotifications {
  return Schema.decodeUnknownSync(TaskSubscriptionAcknowledgedNotificationsSchema)(value);
}
