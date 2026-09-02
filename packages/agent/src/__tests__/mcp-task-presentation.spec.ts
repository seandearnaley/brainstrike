import type { McpTaskRecord } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_TASK_CONTEXT_MAX_BYTES,
  McpTaskPresentationController,
  projectMcpTaskForContext,
  projectMcpTaskRecord,
} from '../mcp/task-presentation';

const SCOPE = {
  authorityEpoch: '00000000-0000-7000-8000-000000000000',
  principalId: 'principal-a',
  resource: 'https://tasks.example.test',
  serverId: 'server-a',
} as const;

function record(overrides: Partial<McpTaskRecord> = {}): McpTaskRecord {
  const createdAt = new Date('2026-09-01T05:00:00.000Z');
  return {
    ...SCOPE,
    createdAt,
    history: [{ at: createdAt, status: 'working' }],
    inputMetadata: null,
    resultMetadata: null,
    status: 'working',
    statusMessage: 'Preparing export',
    taskId: 'task-a',
    terminalAt: null,
    updatedAt: new Date('2026-09-01T05:00:01.000Z'),
    ...overrides,
  };
}

describe('MCP task presentation', () => {
  it('keeps only the newest bounded transition history and omits task payloads', () => {
    const history = Array.from({ length: 32 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 8, 1, 5, 0, index)),
      status: index % 2 === 0 ? ('working' as const) : ('input_required' as const),
    }));

    const presentation = projectMcpTaskRecord(
      record({
        history,
        inputMetadata: { inputRequests: { secret: 'not renderer data' } },
        resultMetadata: { result: 'not renderer data' },
      })
    );

    expect(presentation.history).toHaveLength(8);
    expect(presentation.history[0]?.at).toBe('2026-09-01T05:00:24.000Z');
    expect(presentation.omittedHistoryEntries).toBe(24);
    expect(JSON.stringify(presentation)).not.toContain('not renderer data');
  });

  it('projects a byte-bounded context summary without payload metadata or control identity', () => {
    // 1,024 four-byte glyphs: exactly the 4,096-byte repository bound, above
    // the 2,048-byte context budget.
    const presentation = projectMcpTaskRecord(record({ statusMessage: '🤖'.repeat(1024) }));
    expect(() => projectMcpTaskRecord(record({ statusMessage: '🤖'.repeat(1025) }))).toThrow(
      /exceeds 4096 UTF-8 bytes/u
    );
    const context = projectMcpTaskForContext(presentation);
    const serialized = JSON.stringify(context);

    expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(
      MCP_TASK_CONTEXT_MAX_BYTES
    );
    expect(serialized).not.toContain(SCOPE.principalId);
    expect(serialized).not.toContain(SCOPE.resource);
    expect(context.statusMessage).toMatch(/\u2026 \[truncated\]$/u);
  });

  it.each([
    {
      code: 'stale_handle',
      environment: {
        capabilityAvailable: true,
        protocolVersion: '2026-07-28',
        scope: { ...SCOPE, authorityEpoch: '00000000-0000-7000-8000-000000000001' },
      },
    },
    {
      code: 'lost_principal',
      environment: {
        capabilityAvailable: true,
        protocolVersion: '2026-07-28',
        scope: { ...SCOPE, principalId: 'principal-b' },
      },
    },
    {
      code: 'unsupported_version',
      environment: { capabilityAvailable: true, protocolVersion: '2025-11-25', scope: SCOPE },
    },
    {
      code: 'capability_removed',
      environment: { capabilityAvailable: false, protocolVersion: '2026-07-28', scope: SCOPE },
    },
  ] as const)(
    'returns stable $code diagnostics before calling an authority',
    async ({ code, environment }) => {
      const execute = vi.fn();
      const controller = new McpTaskPresentationController({
        execute,
        readEnvironment: () => environment,
      });

      await expect(
        controller.act({ action: 'recover', handle: projectMcpTaskRecord(record()).handle })
      ).resolves.toMatchObject({ diagnostic: { code }, ok: false });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('passes the exact fenced handle to recovery and cancellation authorities', async () => {
    const recovered = record({ statusMessage: 'Recovered after restart' });
    const cancelled = record({
      status: 'cancelled',
      statusMessage: 'Cancelled by user',
      terminalAt: new Date('2026-09-01T05:00:02.000Z'),
    });
    const execute = vi.fn().mockResolvedValueOnce(recovered).mockResolvedValueOnce(cancelled);
    const controller = new McpTaskPresentationController({
      execute,
      readEnvironment: () => ({
        capabilityAvailable: true,
        protocolVersion: '2026-07-28',
        scope: SCOPE,
      }),
    });
    const handle = projectMcpTaskRecord(record()).handle;

    await expect(controller.act({ action: 'recover', handle })).resolves.toMatchObject({
      ok: true,
      task: { recovery: 'live', statusMessage: 'Recovered after restart' },
    });
    await expect(controller.act({ action: 'cancel', handle })).resolves.toMatchObject({
      ok: true,
      task: { canCancel: false, status: 'cancelled' },
    });
    expect(execute).toHaveBeenNthCalledWith(1, { action: 'recover', handle });
    expect(execute).toHaveBeenNthCalledWith(2, { action: 'cancel', handle });
  });

  it('rejects an action whose authority epoch changes while the authority is running', async () => {
    const execute = vi.fn().mockResolvedValue(record());
    const readEnvironment = vi
      .fn()
      .mockReturnValueOnce({
        capabilityAvailable: true,
        protocolVersion: '2026-07-28',
        scope: SCOPE,
      })
      .mockReturnValueOnce({
        capabilityAvailable: true,
        protocolVersion: '2026-07-28',
        scope: { ...SCOPE, authorityEpoch: '00000000-0000-7000-8000-000000000001' },
      });
    const controller = new McpTaskPresentationController({ execute, readEnvironment });

    await expect(
      controller.act({ action: 'recover', handle: projectMcpTaskRecord(record()).handle })
    ).resolves.toMatchObject({ diagnostic: { code: 'stale_handle' }, ok: false });
  });
});
