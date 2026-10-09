import { describe, expect, it } from 'vitest';
import {
  MCP_TASK_PRESENTATION_HISTORY_LIMIT,
  McpTaskPresentationSchema,
  parseMcpTaskActionResult,
  parseMcpTaskPresentation,
} from '../mcp-task-presentation.js';

const HANDLE = {
  authorityEpoch: '00000000-0000-7000-8000-000000000000',
  principalId: 'principal-a',
  resource: 'https://tasks.example.test',
  serverId: 'server-a',
  taskId: 'task-a',
} as const;

describe('MCP task presentation contract', () => {
  it('accepts a bounded status projection with an opaque exact handle', () => {
    const presentation = {
      canCancel: true,
      createdAt: '2026-09-01T05:00:00.000Z',
      handle: HANDLE,
      history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
      omittedHistoryEntries: 0,
      recovery: 'live',
      status: 'working',
      statusMessage: 'Preparing export',
      updatedAt: '2026-09-01T05:00:01.000Z',
    };

    expect(parseMcpTaskPresentation(presentation)).toEqual(presentation);
  });

  it('rejects unbounded history and persistence-only metadata', () => {
    const history = Array.from({ length: MCP_TASK_PRESENTATION_HISTORY_LIMIT + 1 }, (_, index) => ({
      at: `2026-09-01T05:00:${String(index).padStart(2, '0')}.000Z`,
      status: 'working' as const,
    }));
    const result = McpTaskPresentationSchema.safeParse({
      canCancel: true,
      createdAt: '2026-09-01T05:00:00.000Z',
      handle: HANDLE,
      history,
      inputMetadata: { prompt: 'must not cross the renderer contract' },
      omittedHistoryEntries: 0,
      recovery: 'live',
      status: 'working',
      statusMessage: null,
      updatedAt: '2026-09-01T05:00:01.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed or partial control identity', () => {
    expect(() =>
      parseMcpTaskPresentation({
        canCancel: true,
        createdAt: '2026-09-01T05:00:00.000Z',
        handle: { ...HANDLE, principalId: '' },
        history: [],
        omittedHistoryEntries: 0,
        recovery: 'live',
        status: 'working',
        statusMessage: null,
        updatedAt: '2026-09-01T05:00:01.000Z',
      })
    ).toThrow();
  });

  it('rejects the retired connection-generation handle shape', () => {
    const { authorityEpoch: _authorityEpoch, ...identity } = HANDLE;

    expect(() =>
      parseMcpTaskPresentation({
        canCancel: true,
        createdAt: '2026-09-01T05:00:00.000Z',
        handle: { ...identity, generation: 7 },
        history: [],
        omittedHistoryEntries: 0,
        recovery: 'live',
        status: 'working',
        statusMessage: null,
        updatedAt: '2026-09-01T05:00:01.000Z',
      })
    ).toThrow();
  });

  it('bounds the status message by UTF-8 bytes rather than JavaScript characters', () => {
    expect(() =>
      parseMcpTaskPresentation({
        canCancel: true,
        createdAt: '2026-09-01T05:00:00.000Z',
        handle: HANDLE,
        history: [],
        omittedHistoryEntries: 0,
        recovery: 'live',
        status: 'working',
        statusMessage: 'é'.repeat(3000),
        updatedAt: '2026-09-01T05:00:01.000Z',
      })
    ).toThrow();
  });
});

describe('MCP task action results at a process boundary (BST-1930 c5c)', () => {
  const task = {
    canCancel: false,
    createdAt: '2026-09-01T05:00:00.000Z',
    handle: HANDLE,
    history: [{ at: '2026-09-01T05:00:00.000Z', status: 'cancelled' }],
    omittedHistoryEntries: 0,
    recovery: 'live',
    status: 'cancelled',
    statusMessage: null,
    updatedAt: '2026-09-01T05:00:01.000Z',
  } as const;

  it('keeps an action that succeeded with its task, or one that failed with its diagnostic', () => {
    expect(parseMcpTaskActionResult({ ok: true, task })).toEqual({ ok: true, task });
    const failed = { diagnostic: { code: 'stale_handle', message: 'Task is gone' }, ok: false };
    expect(parseMcpTaskActionResult(failed)).toEqual(failed);
  });

  it('refuses an outcome that mixes the two', () => {
    expect(() => parseMcpTaskActionResult({ ok: true })).toThrow();
    expect(() =>
      parseMcpTaskActionResult({
        diagnostic: { code: 'stale_handle', message: 'Task is gone' },
        ok: false,
        task,
      })
    ).toThrow();
  });
});
