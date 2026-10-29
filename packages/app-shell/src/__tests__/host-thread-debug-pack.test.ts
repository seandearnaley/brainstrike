import { describe, expect, it, vi } from 'vitest';
import {
  buildHostThreadDebugPack,
  formatHostThreadDebugPack,
  type HostThreadDebugSnapshot,
} from '../diagnostics/host-thread-debug-pack';
import type { ThreadDebugHostEvidence } from '../diagnostics/thread-debug-pack';

// Host evidence is a required, explicit input; these format cases are not about it.
const HOST_NOT_UNDER_TEST: ThreadDebugHostEvidence = {
  hostLog: { reason: 'not under test', status: 'unavailable' },
  processCounters: { reason: 'not under test', status: 'unavailable' },
  window: null,
};

function snapshot(overrides: Partial<HostThreadDebugSnapshot> = {}): HostThreadDebugSnapshot {
  return {
    activeRunIds: [],
    capturedAt: '2026-09-16T03:00:00.000Z',
    earliestRunStartMs: Date.parse('2026-09-10T00:00:00.000Z'),
    rootThreadId: 'root',
    threads: [{ parentThreadId: null, rows: [], threadId: 'root' }],
    ...overrides,
  };
}

describe('host thread debug pack', () => {
  it('names why host evidence is missing and clamps the log window to 24 hours', async () => {
    const noBridge = JSON.parse(await buildHostThreadDebugPack(snapshot(), null));
    expect(noBridge.sections.hostLog).toBeNull();
    expect(noBridge.sections.processCounters).toBeNull();
    expect(noBridge.manifest.host.hostLog).toMatch(/^unavailable: no desktop diagnostics bridge/u);
    expect(noBridge.manifest.host.processCounters).toMatch(
      /^unavailable: no desktop diagnostics bridge/u
    );
    expect(noBridge.manifest.host.window).toBeNull();

    const failed = JSON.parse(
      await buildHostThreadDebugPack(snapshot(), {
        readMainLogWindow: vi
          .fn()
          .mockRejectedValue(new Error('Main log file logging is disabled')),
        readProcessCounters: vi.fn().mockResolvedValue({ installedAt: null }),
      })
    );
    expect(failed.manifest.host).toEqual({
      hostLog: 'unavailable: Main log file logging is disabled',
      processCounters: 'unavailable: malformed process counter result (no samples array)',
      window: { since: '2026-09-15T03:00:00.000Z', until: '2026-09-16T03:00:00.000Z' },
    });
    expect(failed.sections.processCounters).toBeNull();
  });

  it('does not read the host log without a run start to bound its window', async () => {
    const readMainLogWindow = vi.fn();
    const pack = JSON.parse(
      await buildHostThreadDebugPack(snapshot({ earliestRunStartMs: null }), {
        readMainLogWindow,
        readProcessCounters: vi.fn().mockResolvedValue({ samples: [] }),
      })
    );
    expect(readMainLogWindow).not.toHaveBeenCalled();
    expect(pack.manifest.host.hostLog).toBe(
      'unavailable: no run start in the snapshot to bound the log window'
    );
    expect(pack.sections.processCounters).toEqual({ samples: [] });
  });

  it('redacts secrets inside thread rows and host log lines', () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const pack = formatHostThreadDebugPack(
      snapshot({
        threads: [
          {
            parentThreadId: null,
            rows: [{ seq: 1, text: `key ${apiKey}`, type: 'stream.chunk' }],
            threadId: 'root',
          },
        ],
      }),
      {
        hostLog: { status: 'included', value: { lines: [`{"msg":"${apiKey}"}`] } },
        processCounters: HOST_NOT_UNDER_TEST.processCounters,
        window: null,
      }
    );
    expect(pack).not.toContain(apiKey);
    expect(JSON.parse(pack).manifest.redaction.valueCount).toBe(2);
  });

  it('scrubs and counts a secret shape inside each unavailable host evidence reason', () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    const pack = formatHostThreadDebugPack(snapshot(), {
      hostLog: {
        reason: `not readable at /tmp/${apiKey}/brainstrike.log`,
        status: 'unavailable',
      },
      processCounters: {
        reason: `counter read rejected for ${apiKey} by main`,
        status: 'unavailable',
      },
      window: null,
    });
    expect(pack).not.toContain(apiKey);
    const { manifest } = JSON.parse(pack);
    // Paths are documented export content: only the secret shape is replaced.
    expect(manifest.host.hostLog).toBe(
      'unavailable: not readable at /tmp/[redacted-secret:api-key]/brainstrike.log'
    );
    expect(manifest.host.processCounters).toBe(
      'unavailable: counter read rejected for [redacted-secret:api-key] by main'
    );
    expect(manifest.redaction.valueCount).toBe(2);
  });
});
