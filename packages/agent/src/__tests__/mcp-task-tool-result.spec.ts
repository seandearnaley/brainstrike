import type { McpTaskPresentation } from '@brainstrike/assistant-contract';
import type { CreateTaskResult } from '@brainstrike/mcp-tasks-extension';
import { describe, expect, it, vi } from 'vitest';
import { REGISTERED_EXTENSION_RESULT_KEY } from '../mcp/client-extension-registry';
import {
  createMcpTaskToolTracking,
  MCP_TASK_SETTLEMENT_WAIT_MS,
  projectMcpTaskToolModelOutput,
  readMcpCreatedTaskResult,
  resolveMcpTaskSettlementTimeoutMs,
  settleMcpTaskToolResult,
} from '../mcp/mcp-task-tool-result';
import { MCP_TASK_CONTEXT_MAX_BYTES } from '../mcp/task-presentation';
import type { McpTaskTrackingCapability } from '../mcp/task-tracking';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import { applyToolModelOutputProjections } from '../tool-projection/tool-model-output';

const CREATED_TASK: CreateTaskResult = {
  createdAt: '2026-09-01T05:00:00.000Z',
  lastUpdatedAt: '2026-09-01T05:00:00.000Z',
  resultType: 'task',
  status: 'working',
  taskId: 'task-a',
  ttlMs: null,
};

const HANDLE = {
  authorityEpoch: '00000000-0000-7000-8000-000000000000',
  principalId: 'principal-a',
  resource: 'https://tasks.example.test',
  serverId: 'remote',
  taskId: 'task-a',
} as const;

function presentation(overrides: Partial<McpTaskPresentation> = {}): McpTaskPresentation {
  return {
    canCancel: true,
    createdAt: '2026-09-01T05:00:00.000Z',
    handle: HANDLE,
    history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
    omittedHistoryEntries: 0,
    recovery: 'live',
    status: 'working',
    statusMessage: 'Preparing export',
    updatedAt: '2026-09-01T05:00:01.000Z',
    ...overrides,
  };
}

function fakeCapability(
  outcome: Awaited<ReturnType<McpTaskTrackingCapability['awaitSettlement']>>
): McpTaskTrackingCapability & {
  awaitSettlement: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
} {
  return {
    awaitSettlement: vi.fn(async () => outcome),
    track: vi.fn(async () => presentation()),
  };
}

describe('readMcpCreatedTaskResult', () => {
  it('detects a direct CreateTaskResult', () => {
    expect(readMcpCreatedTaskResult(CREATED_TASK)).toEqual(CREATED_TASK);
  });

  it('detects the registry wrapper around a CreateTaskResult', () => {
    expect(
      readMcpCreatedTaskResult({
        [REGISTERED_EXTENSION_RESULT_KEY]: CREATED_TASK,
        content: [],
        resultType: 'complete',
      })
    ).toEqual(CREATED_TASK);
  });

  it('ignores ordinary tool results and non-task wrapped results', () => {
    expect(readMcpCreatedTaskResult({ content: [{ text: 'ok', type: 'text' }] })).toBeUndefined();
    expect(readMcpCreatedTaskResult({ content: [], resultType: 'complete' })).toBeUndefined();
    expect(
      readMcpCreatedTaskResult({
        [REGISTERED_EXTENSION_RESULT_KEY]: { resultType: 'other' },
        content: [],
        resultType: 'complete',
      })
    ).toBeUndefined();
    expect(readMcpCreatedTaskResult('task')).toBeUndefined();
    expect(readMcpCreatedTaskResult(null)).toBeUndefined();
  });

  it('rejects a malformed task result instead of coercing it', () => {
    expect(() => readMcpCreatedTaskResult({ resultType: 'task', taskId: 'task-a' })).toThrow();
  });
});

describe('resolveMcpTaskSettlementTimeoutMs', () => {
  it('uses the constant wait when the tool guard leaves room for it', () => {
    expect(resolveMcpTaskSettlementTimeoutMs(60_000)).toBe(MCP_TASK_SETTLEMENT_WAIT_MS);
    expect(MCP_TASK_SETTLEMENT_WAIT_MS).toBe(45_000);
  });

  it('caps the wait at three quarters of the tool guard budget', () => {
    expect(resolveMcpTaskSettlementTimeoutMs(20_000)).toBe(15_000);
  });

  it('refuses a tool guard budget that cannot hold any settlement wait', () => {
    expect(() => resolveMcpTaskSettlementTimeoutMs(1)).toThrow(/tool timeout/iu);
    expect(() => resolveMcpTaskSettlementTimeoutMs(Number.NaN)).toThrow(/tool timeout/iu);
  });
});

describe('settleMcpTaskToolResult', () => {
  it('throws when a task arrives without a tracking capability', async () => {
    await expect(
      settleMcpTaskToolResult({
        configuredServerId: 'remote',
        result: CREATED_TASK,
        toolName: 'export',
        tracking: undefined,
      })
    ).rejects.toThrow(
      'MCP tool "remote.export" returned a task but this host has no task tracking capability'
    );
  });

  it('tracks the task, waits within the bound, and returns the persisted marker', async () => {
    const settledTask = presentation({
      canCancel: false,
      history: [
        { at: '2026-09-01T05:00:00.000Z', status: 'working' },
        { at: '2026-09-01T05:00:05.000Z', status: 'completed' },
      ],
      recovery: 'terminal',
      status: 'completed',
      statusMessage: null,
      updatedAt: '2026-09-01T05:00:05.000Z',
    });
    const capability = fakeCapability({ settled: true, task: settledTask });
    const signal = new AbortController().signal;

    const result = await settleMcpTaskToolResult({
      configuredServerId: 'remote',
      result: CREATED_TASK,
      signal,
      toolName: 'export',
      tracking: createMcpTaskToolTracking(capability, 60_000),
    });

    expect(capability.track).toHaveBeenCalledWith(
      { configuredServerId: 'remote', result: CREATED_TASK, toolName: 'export' },
      signal
    );
    expect(capability.awaitSettlement).toHaveBeenCalledWith(HANDLE, {
      signal,
      timeoutMs: MCP_TASK_SETTLEMENT_WAIT_MS,
    });
    expect(result).toEqual({ kind: 'mcp-task', task: settledTask });
  });

  it('returns the live presentation when settlement times out', async () => {
    const live = presentation({ statusMessage: 'Still exporting' });
    const capability = fakeCapability({ reason: 'timeout', settled: false, task: live });

    const result = await settleMcpTaskToolResult({
      configuredServerId: 'remote',
      result: CREATED_TASK,
      toolName: 'export',
      tracking: createMcpTaskToolTracking(capability, 20_000),
    });

    expect(capability.awaitSettlement).toHaveBeenCalledWith(HANDLE, { timeoutMs: 15_000 });
    expect(result).toEqual({ kind: 'mcp-task', task: live });
  });
});

describe('projectMcpTaskToolModelOutput', () => {
  it('projects only the persisted task marker, without the control identity', () => {
    const projected = projectMcpTaskToolModelOutput({ kind: 'mcp-task', task: presentation() });

    expect(projected).toEqual({
      type: 'json',
      value: {
        history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
        kind: 'mcp_task_status',
        omittedHistoryEntries: 0,
        status: 'working',
        statusMessage: 'Preparing export',
        updatedAt: '2026-09-01T05:00:01.000Z',
      },
    });
    expect(JSON.stringify(projected)).not.toContain(HANDLE.principalId);
    expect(JSON.stringify(projected)).not.toContain(HANDLE.taskId);
  });

  it('leaves every other MCP result to the generic projection', () => {
    expect(
      projectMcpTaskToolModelOutput({ content: [{ text: 'ok', type: 'text' }] })
    ).toBeUndefined();
    expect(projectMcpTaskToolModelOutput({ kind: 'mcp-task' })).toBeUndefined();
  });

  it('fits the run domain budget through the projection pipeline at the smallest budget', async () => {
    const tool = {
      description: 'Remote export task tool.',
      execute: async () => undefined,
      id: 'remote.export',
      toModelOutput: projectMcpTaskToolModelOutput,
    };
    const smallestBudget = resolveScaledToolResultBudget(1);
    const projected = applyToolModelOutputProjections(
      { remote_export: tool },
      new Map([['remote_export', 'remote.export']]),
      undefined,
      smallestBudget
    );
    const projector = (projected['remote_export'] as typeof tool).toModelOutput;
    const output = await projector({
      kind: 'mcp-task',
      task: presentation({ statusMessage: 'x'.repeat(4096) }),
    });

    const serialized = JSON.stringify(output);
    expect(serialized.length).toBeLessThanOrEqual(smallestBudget.domainModelResultCharBudget);
    expect(serialized.length).toBeLessThanOrEqual(MCP_TASK_CONTEXT_MAX_BYTES + 24);
    expect(output).toMatchObject({ type: 'json', value: { kind: 'mcp_task_status' } });
    expect((output as { value: { statusMessage: string } }).value.statusMessage).toMatch(
      /… \[truncated\]$/u
    );
  });
});
