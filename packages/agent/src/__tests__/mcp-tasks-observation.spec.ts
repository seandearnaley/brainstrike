import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import { describe, expect, it, vi } from 'vitest';
import { McpTaskObservationPort } from '../mcp/tasks-observation.js';

const task = {
  createdAt: '2026-09-02T04:00:00.000Z',
  lastUpdatedAt: '2026-09-02T04:00:01.000Z',
  status: 'working',
  taskId: 'task-1',
  ttlMs: null,
} as GetTaskResult;

describe('MCP task observation port', () => {
  it('is a no-op without a consumer and reports consumer errors instead of throwing', async () => {
    const onConsumerError = vi.fn();
    const port = new McpTaskObservationPort({ onConsumerError });

    await expect(port.publish(task)).resolves.toBeUndefined();
    expect(() => port.publishFailure('task-1', new Error('poll failed'))).not.toThrow();
    expect(onConsumerError).not.toHaveBeenCalled();

    const observeFailure = new Error('outside the owned task set');
    const failFailure = new Error('failure outside the owned task set');
    const release = port.subscribe({
      fail: () => {
        throw failFailure;
      },
      observe: async () => {
        throw observeFailure;
      },
    });
    await expect(port.publish(task)).resolves.toBeUndefined();
    port.publishFailure('task-1', new Error('poll failed'));
    expect(onConsumerError.mock.calls).toEqual([
      ['task-1', observeFailure],
      ['task-1', failFailure],
    ]);

    release();
    await expect(port.publish(task)).resolves.toBeUndefined();
    expect(onConsumerError).toHaveBeenCalledTimes(2);
  });

  it('keeps wake routing strict: a wake with no polling authority is a wiring defect', () => {
    const port = new McpTaskObservationPort({ onConsumerError: vi.fn() });
    expect(() => port.requestPoll('task-1')).toThrow(/no polling authority/u);
    const wake = vi.fn();
    const detach = port.attachAuthority({ wake });
    expect(() => port.attachAuthority({ wake })).toThrow(/already has a polling authority/u);
    port.requestPoll('task-1');
    expect(wake).toHaveBeenCalledWith('task-1');
    detach();
    expect(() => port.requestPoll('task-1')).toThrow(/no polling authority/u);
  });
});
