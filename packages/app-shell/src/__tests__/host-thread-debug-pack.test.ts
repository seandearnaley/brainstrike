import { describe, expect, it, vi } from 'vitest';
import {
  buildHostThreadDebugPack,
  formatHostThreadDebugPack,
  type HostThreadDebugSnapshot,
} from '../diagnostics/host-thread-debug-pack';
import type { ThreadDebugHostEvidence } from '../diagnostics/thread-debug-pack';

// Host evidence is a required, explicit input; these format cases are not about it.
const HOST_NOT_UNDER_TEST: ThreadDebugHostEvidence = {
  crashDumps: { reason: 'not under test', status: 'unavailable' },
  diagnosticEvents: { reason: 'not under test', status: 'unavailable' },
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
    expect(noBridge.sections.diagnosticEvents).toBeNull();
    expect(noBridge.sections.crashDumps).toBeNull();
    expect(noBridge.manifest.host.hostLog).toMatch(/^unavailable: no desktop diagnostics bridge/u);
    expect(noBridge.manifest.host.processCounters).toMatch(
      /^unavailable: no desktop diagnostics bridge/u
    );
    expect(noBridge.manifest.host.window).toBeNull();

    const failed = JSON.parse(
      await buildHostThreadDebugPack(snapshot(), {
        listCrashDumps: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
        queryEvents: vi.fn().mockRejectedValue(new Error('Malformed diagnostic record')),
        readMainLogWindow: vi
          .fn()
          .mockRejectedValue(new Error('Main log file logging is disabled')),
        readProcessCounters: vi.fn().mockResolvedValue({ installedAt: null }),
      })
    );
    expect(failed.manifest.host).toEqual({
      crashDumps: 'unavailable: EACCES: permission denied',
      diagnosticEvents: 'unavailable: Malformed diagnostic record',
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
        listCrashDumps: vi.fn().mockResolvedValue({ dumps: [] }),
        queryEvents: vi.fn().mockResolvedValue([]),
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

  it('carries the records the status bar counts, though they came before the run (BST-2347)', async () => {
    const apiKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    // Logged at startup, an hour before the snapshot's only run.
    const startup = {
      context: { error: { message: 'No API key configured for provider "openrouter".' } },
      fingerprint: 'c93eb69d4c265574',
      message: `Untyped failure crossed a process boundary ${apiKey}`,
      occurredAt: Date.parse('2026-09-16T01:00:00.000Z'),
      scope: 'AgentHostConnection',
      severity: 'error',
      source: 'electron-main',
    };
    const queryEvents = vi.fn().mockResolvedValue([startup]);
    const pack = JSON.parse(
      await buildHostThreadDebugPack(
        snapshot({ earliestRunStartMs: Date.parse('2026-09-16T02:00:00.000Z') }),
        {
          listCrashDumps: vi.fn().mockResolvedValue({ dumps: [] }),
          queryEvents,
          readMainLogWindow: vi.fn().mockResolvedValue({ lines: [] }),
          readProcessCounters: vi.fn().mockResolvedValue({ samples: [] }),
        }
      )
    );

    expect(queryEvents).toHaveBeenCalledExactlyOnceWith({ limit: 50 });
    expect(pack.manifest.host.diagnosticEvents).toBe('included');
    expect(pack.sections.diagnosticEvents.events).toEqual([
      {
        ...startup,
        message: 'Untyped failure crossed a process boundary [redacted-secret:api-key]',
      },
    ]);
  });

  it('names the minidumps a crash left, from any launch (BST-2351)', async () => {
    const dumps = {
      directory: '/profile/Crashpad',
      dumps: [
        {
          folder: 'completed',
          modifiedAt: '2026-09-15T23:00:00.000Z',
          name: '6f1c0a52-1d2b-4c1e-9a77-0c4c3a1b2d3e.dmp',
          sizeBytes: 482_113,
        },
      ],
      totalCount: 1,
    };
    const pack = JSON.parse(
      await buildHostThreadDebugPack(snapshot(), {
        listCrashDumps: vi.fn().mockResolvedValue(dumps),
        queryEvents: vi.fn().mockResolvedValue([]),
        readMainLogWindow: vi.fn().mockResolvedValue({ lines: [] }),
        readProcessCounters: vi.fn().mockResolvedValue({ samples: [] }),
      })
    );
    expect(pack.manifest.host.crashDumps).toBe('included');
    expect(pack.sections.crashDumps).toEqual(dumps);
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
        ...HOST_NOT_UNDER_TEST,
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
      ...HOST_NOT_UNDER_TEST,
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
