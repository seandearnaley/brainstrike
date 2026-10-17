import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  GetTaskRequestSchema,
  parseMcpCancelTaskParams,
  parseMcpCancelTaskResult,
  parseMcpCreateTaskResult,
  parseMcpGetTaskParams,
  parseMcpGetTaskResult,
  parseMcpTaskStatusNotificationParams,
  parseMcpUpdateTaskParams,
  parseMcpUpdateTaskResult,
} from '../src/index.js';

const WORKING_TASK = {
  createdAt: '2026-08-31T20:00:00Z',
  lastUpdatedAt: '2026-08-31T20:00:01Z',
  status: 'working',
  taskId: 'task-123',
  ttlMs: null,
} as const;

describe('MCP Tasks extension schemas', () => {
  it('accepts string or integer RequestIds and rejects fractional numbers', () => {
    const request = { jsonrpc: '2.0', method: 'tasks/get', params: { taskId: 'task-123' } };

    for (const id of ['request-1', -1, 0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(Schema.decodeUnknownSync(GetTaskRequestSchema)({ ...request, id }).id).toBe(id);
    }
    for (const id of [-1.5, 0.5, 1.5]) {
      expect(() => Schema.decodeUnknownSync(GetTaskRequestSchema)({ ...request, id })).toThrow();
    }
  });

  it('parses the canonical operation and notification shapes', () => {
    expect(parseMcpGetTaskParams({ taskId: 'task-123' })).toEqual({ taskId: 'task-123' });
    expect(parseMcpCancelTaskParams({ taskId: 'task-123' })).toEqual({ taskId: 'task-123' });
    expect(
      parseMcpUpdateTaskParams({
        inputResponses: { roots: { resultType: 'complete', roots: [] } },
        taskId: 'task-123',
      })
    ).toEqual({
      inputResponses: { roots: { resultType: 'complete', roots: [] } },
      taskId: 'task-123',
    });
    expect(parseMcpUpdateTaskResult({ resultType: 'complete' })).toEqual({
      resultType: 'complete',
    });
    expect(parseMcpCancelTaskResult({ resultType: 'complete' })).toEqual({
      resultType: 'complete',
    });
    expect(parseMcpCreateTaskResult({ ...WORKING_TASK, resultType: 'task' })).toMatchObject({
      resultType: 'task',
      status: 'working',
      taskId: 'task-123',
    });
    expect(parseMcpGetTaskResult({ ...WORKING_TASK, resultType: 'complete' })).toMatchObject({
      resultType: 'complete',
      status: 'working',
    });
    expect(parseMcpTaskStatusNotificationParams(WORKING_TASK)).toMatchObject({
      status: 'working',
      taskId: 'task-123',
    });
  });

  it('preserves canonical signed durations and base Task create results', () => {
    expect(
      parseMcpCreateTaskResult({
        ...WORKING_TASK,
        pollIntervalMs: -1,
        resultType: 'task',
        status: 'completed',
        ttlMs: -1,
      })
    ).toMatchObject({ pollIntervalMs: -1, status: 'completed', ttlMs: -1 });
  });

  it('accepts tool-aware sampling input responses', () => {
    expect(
      parseMcpUpdateTaskParams({
        inputResponses: {
          sampling: {
            content: [{ id: 'call-1', input: {}, name: 'weather', type: 'tool_use' }],
            model: 'test-model',
            role: 'assistant',
            stopReason: 'toolUse',
          },
        },
        taskId: 'task-123',
      })
    ).toMatchObject({ inputResponses: { sampling: { stopReason: 'toolUse' } } });
  });

  it.each([
    { ...WORKING_TASK, resultType: 'complete' },
    { ...WORKING_TASK, resultType: 'task', taskId: undefined },
    { ...WORKING_TASK, resultType: 'task', ttlMs: 1.5 },
    { ...WORKING_TASK, resultType: 'task', status: 'unknown' },
    { ...WORKING_TASK, _meta: 'not-an-object', resultType: 'task' },
  ])('rejects malformed create-task results %#', (result) => {
    expect(() => parseMcpCreateTaskResult(result)).toThrow();
  });

  it.each([
    { ...WORKING_TASK, resultType: 'task' },
    { ...WORKING_TASK, resultType: 'complete', status: 'completed' },
    { ...WORKING_TASK, resultType: 'complete', status: 'failed' },
    { ...WORKING_TASK, resultType: 'complete', status: 'input_required' },
    { ...WORKING_TASK, _meta: 'not-an-object', resultType: 'complete' },
  ])('rejects malformed status-discriminated get-task results %#', (result) => {
    expect(() => parseMcpGetTaskResult(result)).toThrow();
  });

  it('rejects malformed operation params and notification payloads', () => {
    expect(() => parseMcpGetTaskParams({})).toThrow();
    expect(() => parseMcpCancelTaskParams({ taskId: 123 })).toThrow();
    expect(() => parseMcpUpdateTaskParams({ inputResponses: [], taskId: 'task-123' })).toThrow();
    expect(() =>
      parseMcpUpdateTaskParams({ inputResponses: { invalid: { bogus: true } }, taskId: 'task-123' })
    ).toThrow();
    expect(() =>
      parseMcpTaskStatusNotificationParams({ ...WORKING_TASK, createdAt: 123 })
    ).toThrow();
  });

  it('rejects values that cannot exist on the JSON wire', () => {
    expect(() =>
      parseMcpGetTaskResult({
        ...WORKING_TASK,
        result: { callback: () => undefined },
        resultType: 'complete',
        status: 'completed',
      })
    ).toThrow();
    expect(() =>
      parseMcpGetTaskResult({
        ...WORKING_TASK,
        resultType: 'complete',
        status: 'working',
        trace: undefined,
      })
    ).toThrow();
  });

  it('accepts every status-specific required payload and preserves extension fields', () => {
    expect(
      parseMcpGetTaskResult({
        ...WORKING_TASK,
        inputRequests: {
          roots: { id: 'roots-1', jsonrpc: '2.0', method: 'roots/list' },
        },
        resultType: 'complete',
        status: 'input_required',
      })
    ).toMatchObject({
      inputRequests: { roots: { id: 'roots-1', jsonrpc: '2.0', method: 'roots/list' } },
      status: 'input_required',
    });
    expect(
      parseMcpGetTaskResult({
        ...WORKING_TASK,
        result: { content: [] },
        resultType: 'complete',
        status: 'completed',
      })
    ).toMatchObject({ result: { content: [] }, status: 'completed' });
    expect(
      parseMcpGetTaskResult({
        ...WORKING_TASK,
        error: { code: -32_000, message: 'failed' },
        resultType: 'complete',
        status: 'failed',
      })
    ).toMatchObject({ error: { code: -32_000, message: 'failed' }, status: 'failed' });
    expect(
      parseMcpGetTaskResult({
        ...WORKING_TASK,
        'com.example/trace': 'trace-123',
        resultType: 'complete',
        status: 'cancelled',
      })
    ).toMatchObject({ 'com.example/trace': 'trace-123', status: 'cancelled' });
  });
});
