import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import type { z } from 'zod';
import * as current from '../src/schema.js';
import * as legacy from './fixtures/pre-effect-schema.js';

const task = {
  createdAt: 'date',
  lastUpdatedAt: 'date',
  status: 'working',
  taskId: 'task',
  ttlMs: null,
};
const completed = { ...task, result: { content: [] }, status: 'completed' };
const failed = {
  ...task,
  error: { code: -32_000, data: { nested: [1, null] }, message: 'failed' },
  status: 'failed',
};
const input = {
  ...task,
  inputRequests: { roots: { id: 1, jsonrpc: '2.0', method: 'roots/list' } },
  status: 'input_required',
};
const corpus: unknown[] = [
  undefined,
  null,
  true,
  0,
  '',
  [],
  {},
  new Date(0),
  new Map(),
  task,
  completed,
  failed,
  input,
  { ...task, status: 'cancelled' },
  ...[task, completed, failed, input].flatMap((value) => [
    { ...value, resultType: 'task' },
    { ...value, resultType: 'complete' },
    { ...value, _meta: undefined, pollIntervalMs: undefined, statusMessage: undefined },
    { ...value, pollIntervalMs: -1, ttlMs: Number.MIN_SAFE_INTEGER },
    { ...value, ttlMs: Number.MAX_SAFE_INTEGER },
    { ...value, ttlMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, ttlMs: 0.5 },
    { ...value, ttlMs: Number.NaN },
    { ...value, 'example/extension': { deep: [1, 'ok', false, null] } },
    { ...value, 'example/extension': undefined },
    { ...value, 'example/extension': () => 0 },
    { ...value, _meta: { trace: [1] } },
    { ...value, _meta: { trace: undefined } },
    { ...value, status: 'unknown' },
  ]),
  { taskId: 'task' },
  { taskId: '' },
  { taskId: 1 },
  { inputResponses: { roots: { resultType: 'complete', roots: [] } }, taskId: 'task' },
  { inputResponses: { roots: { bogus: true } }, taskId: 'task' },
  { resultType: 'complete' },
  { _meta: undefined, resultType: 'complete' },
  { taskIds: undefined },
  { taskIds: [] },
  { extension: [1], taskIds: ['task'] },
  { id: 1, jsonrpc: '2.0', method: 'tasks/get', params: { taskId: 'task' } },
  { id: 0.5, jsonrpc: '2.0', method: 'tasks/get', params: { taskId: 'task' } },
];
const subjects: ReadonlyArray<readonly [string, Schema.ConstraintDecoder<unknown>, z.ZodType]> = [
  ['Task', current.TaskSchema, legacy.TaskSchema],
  ['CreateTaskResult', current.CreateTaskResultSchema, legacy.CreateTaskResultSchema],
  ['DetailedTask', current.DetailedTaskSchema, legacy.DetailedTaskSchema],
  ['GetTaskResult', current.GetTaskResultSchema, legacy.GetTaskResultSchema],
  ['GetTaskParams', current.GetTaskParamsSchema, legacy.GetTaskParamsSchema],
  ['UpdateTaskParams', current.UpdateTaskParamsSchema, legacy.UpdateTaskParamsSchema],
  ['UpdateTaskResult', current.UpdateTaskResultSchema, legacy.UpdateTaskResultSchema],
  [
    'TaskStatusNotificationParams',
    current.TaskStatusNotificationParamsSchema,
    legacy.TaskStatusNotificationParamsSchema,
  ],
  [
    'TaskSubscriptionNotifications',
    current.TaskSubscriptionNotificationsSchema,
    legacy.TaskSubscriptionNotificationsSchema,
  ],
  ['GetTaskRequest', current.GetTaskRequestSchema, legacy.GetTaskRequestSchema],
  [
    'TasksExtensionCapability',
    current.TasksExtensionCapabilitySchema,
    legacy.TasksExtensionCapabilitySchema,
  ],
];
for (const [name, schema, oracle] of subjects) {
  test.each(corpus.map((value, index) => ({ index, value })))(
    `${name} preserves wire case $index`,
    ({ value }) => {
      const before = oracle.safeParse(value);
      const after = Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(value);
      expect(Result.isSuccess(after)).toBe(before.success);
      if (before.success && Result.isSuccess(after)) {
        expect(after.success).toEqual(before.data);
      }
    }
  );
}
