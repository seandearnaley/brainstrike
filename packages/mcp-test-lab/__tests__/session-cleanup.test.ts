import { describe, expect, it, vi } from 'vitest';
import { claimMcpLabFaultPlan } from '../src/fault-plan-claim';
import { createMcpLabFaultRuntime } from '../src/fault-runtime';
import { createMcpLabFaultPlan } from '../src/faults';
import { createMcpLabSessionCleanup, type McpLabCleanupResource } from '../src/session-cleanup';

function resource(
  kind: McpLabCleanupResource['kind'],
  close: () => Promise<void>
): McpLabCleanupResource {
  return { close, closed: false, kind };
}

describe('MCP session cleanup ownership', () => {
  it('injects cleanup failure before resources, then delays one retry and freezes one report', async () => {
    vi.useFakeTimers();
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'cleanup_error' },
        id: 'first-cleanup-fails',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
      {
        fault: { delayMs: 25, kind: 'delay' },
        id: 'retry-cleanup-delay',
        match: { method: 'transport/close', occurrence: 2, phase: 'shutdown' },
      },
      {
        fault: { kind: 'drop_response' },
        id: 'untriggered-operation',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const runtime = createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'cleanup-test');
    let closeCalls = 0;
    const cleanup = createMcpLabSessionCleanup({
      faultRuntime: runtime,
      oauthStateCounts: () => ({ clients: 0, codes: 0, states: 0, tokens: 0 }),
      resources: [
        resource('http-listener', async () => {
          closeCalls += 1;
        }),
      ],
    });

    try {
      await expect(cleanup.close()).rejects.toThrow(/first-cleanup-fails.*cleanup failure/i);
      expect(closeCalls).toBe(0);
      expect(cleanup.closed).toBe(false);

      const retry = cleanup.close();
      await vi.advanceTimersByTimeAsync(24);
      expect(closeCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      const report = await retry;
      expect(closeCalls).toBe(1);
      expect(cleanup.closed).toBe(true);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.oauthRecordsRemaining)).toBe(true);
      expect(Object.isFrozen(report.untriggeredFaultIds)).toBe(true);
      expect(report.untriggeredFaultIds).toEqual(['untriggered-operation']);
      expect(() => (report.untriggeredFaultIds as string[]).push('mutation')).toThrow();
      await expect(cleanup.close()).resolves.toBe(report);
      expect(report.untriggeredFaultIds).toEqual(['untriggered-operation']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares concurrent attempts and retries only resources that remain owned', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const secretResourceError = 'Bearer sk-secret-cleanup-resource';
    let failSecond = true;
    const cleanup = createMcpLabSessionCleanup({
      faultRuntime: undefined,
      oauthStateCounts: undefined,
      resources: [
        resource('handler', async () => {
          calls.push('handler');
          await firstReleased;
        }),
        resource('http-listener', async () => {
          calls.push('listener');
          if (failSecond) {
            failSecond = false;
            throw new Error(secretResourceError);
          }
        }),
      ],
    });

    const first = cleanup.close();
    const concurrent = cleanup.close();
    expect(concurrent).toBe(first);
    releaseFirst?.();
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      failedResourceKinds: ['http-listener'],
      message: 'MCP lab cleanup failed for 1 resource(s): http-listener',
      name: 'McpLabResourceCleanupError',
    });
    expect(JSON.stringify(failure)).not.toContain(secretResourceError);
    expect(String(failure)).not.toContain(secretResourceError);
    expect(calls).toEqual(['handler', 'listener']);
    expect(cleanup.closed).toBe(false);

    const report = await cleanup.close();
    expect(calls).toEqual(['handler', 'listener', 'listener']);
    expect(report.httpListenersClosed).toBe(1);
    expect(cleanup.closed).toBe(true);
  });
});
