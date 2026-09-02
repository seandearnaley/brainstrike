import { describe, expect, it } from 'vitest';
import { resolveMcpTaskDeadline, resolveMcpTaskPollDelay } from '../mcp/tasks-lifecycle-state';

const LIMITS = { maxBackoffMs: 30_000, minimumPollMs: 100 } as const;

type Timing = Parameters<typeof resolveMcpTaskDeadline>[0];
type Record = Parameters<typeof resolveMcpTaskDeadline>[1];

function timing(overrides: { pollIntervalMs?: number; ttlMs?: number | null } = {}): Timing {
  return {
    createdAt: '2026-09-02T04:00:00.000Z',
    lastUpdatedAt: '2026-09-02T04:00:00.000Z',
    pollIntervalMs: overrides.pollIntervalMs,
    ttlMs: overrides.ttlMs ?? null,
  } as Timing;
}

function persistedAt(ms: number): Record {
  return { createdAt: new Date(ms) } as Record;
}

describe('MCP task deadline', () => {
  it('anchors ttlMs to the local persisted instant, not the server clock', () => {
    // Review of #2915: a server whose clock is five minutes behind must not
    // expire a fresh task before its first poll.
    const at = Date.parse('2026-09-02T04:05:00.000Z');
    const deadline = resolveMcpTaskDeadline(
      timing({ ttlMs: 60_000 }),
      persistedAt(at),
      at + 3_600_000,
      86_400_000
    );
    expect(deadline).toBe(at + 60_000);
  });

  it('keeps the tighter of the local lifetime and the ttl', () => {
    const at = 1_000_000;
    expect(resolveMcpTaskDeadline(timing({ ttlMs: 5000 }), persistedAt(at), at + 999, 60_000)).toBe(
      at + 999
    );
    expect(resolveMcpTaskDeadline(timing(), persistedAt(at), at + 999_999, 60_000)).toBe(
      at + 60_000
    );
  });
});

describe('MCP task poll delay', () => {
  it('clamps a server-supplied interval to the client-owned bounds', () => {
    // Review of #2915: pollIntervalMs: 0 must not pin the client at the
    // minimum, and a huge interval must not stall observation.
    expect(resolveMcpTaskPollDelay(timing({ pollIntervalMs: 0 }), 500, 0, LIMITS)).toBe(100);
    expect(resolveMcpTaskPollDelay(timing({ pollIntervalMs: 10_000_000 }), 500, 0, LIMITS)).toBe(
      30_000
    );
    expect(resolveMcpTaskPollDelay(timing({ pollIntervalMs: 2000 }), 500, 0, LIMITS)).toBe(2000);
  });

  it('lets local backoff dominate a stale server interval while failures are being retried', () => {
    expect(resolveMcpTaskPollDelay(timing({ pollIntervalMs: 100 }), 4000, 2, LIMITS)).toBe(4000);
    expect(resolveMcpTaskPollDelay(timing(), 4000, 2, LIMITS)).toBe(4000);
  });
});
