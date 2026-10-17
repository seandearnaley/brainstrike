import { Schema } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpTaskToolInvocationResult,
  McpTaskListResultSchema,
  parseMcpTaskStatusChangedEvent,
  readMcpTaskToolInvocationResult,
} from '../mcp-task-ipc.js';
import type { McpTaskPresentation } from '../mcp-task-presentation.js';

const presentation: McpTaskPresentation = {
  canCancel: true,
  createdAt: '2026-09-02T00:00:00.000Z',
  handle: {
    authorityEpoch: '4f6c1b1e-6f7d-4c0e-9a3b-0f7a1e2d3c4b',
    principalId: 'principal',
    resource: 'http://127.0.0.1:1/mcp',
    serverId: 'tasks-lab',
    taskId: 'reference-task-1',
  },
  history: [{ at: '2026-09-02T00:00:00.000Z', status: 'working' }],
  omittedHistoryEntries: 0,
  recovery: 'live',
  status: 'working',
  statusMessage: null,
  updatedAt: '2026-09-02T00:00:00.000Z',
};
afterEach(() => {
  vi.restoreAllMocks();
});
describe('MCP task IPC contract', () => {
  it('never schema-walks a result that does not carry the task marker kind', () => {
    let payloadReads = 0;
    const large = {
      content: Array.from({ length: 5000 }, (_, index) => ({ text: `row ${index}`, type: 'text' })),
      structuredContent: { rows: Array.from({ length: 5000 }, (_, index) => ({ index })) },
    };
    Object.defineProperty(large, 'task', {
      get: () => {
        payloadReads += 1;
        return {};
      },
    });
    expect(readMcpTaskToolInvocationResult(large)).toBeUndefined();
    expect(readMcpTaskToolInvocationResult({ ...large, kind: 'mcp-app' })).toBeUndefined();
    expect(readMcpTaskToolInvocationResult('mcp-task')).toBeUndefined();
    expect(readMcpTaskToolInvocationResult(null)).toBeUndefined();
    expect(readMcpTaskToolInvocationResult(presentation)).toBeUndefined();
    expect(payloadReads).toBe(0);
    expect(
      readMcpTaskToolInvocationResult(
        Object.defineProperty({ kind: 'mcp-task' }, 'task', {
          get: () => {
            payloadReads += 1;
            return {};
          },
        })
      )
    ).toBeUndefined();
    expect(payloadReads).toBe(1);
    expect(
      readMcpTaskToolInvocationResult(createMcpTaskToolInvocationResult(presentation))
    ).toEqual(presentation);
    expect(payloadReads).toBe(1);
  });
  it('round-trips a persisted task tool result exactly and rejects near misses', () => {
    const result = createMcpTaskToolInvocationResult(presentation);
    expect(readMcpTaskToolInvocationResult(result)).toEqual(presentation);
    expect(readMcpTaskToolInvocationResult({ ...result, extra: true })).toBeUndefined();
    expect(readMcpTaskToolInvocationResult({ kind: 'mcp-task' })).toBeUndefined();
    expect(readMcpTaskToolInvocationResult({ content: [], structuredContent: {} })).toBeUndefined();
    expect(readMcpTaskToolInvocationResult(presentation)).toBeUndefined();
  });
  it('validates list results and status events strictly', () => {
    expect(
      Schema.decodeUnknownSync(McpTaskListResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ tasks: [presentation] }).tasks
    ).toHaveLength(1);
    expect(() =>
      Schema.decodeUnknownSync(McpTaskListResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ cursor: 1, tasks: [presentation] })
    ).toThrow();
    expect(parseMcpTaskStatusChangedEvent({ task: presentation }).task.status).toBe('working');
    expect(() =>
      parseMcpTaskStatusChangedEvent({ task: { ...presentation, status: 'x' } })
    ).toThrow();
  });
});
