// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { type DiagnosticEvent, serializeDiagnosticEventLine } from '@brainstrike/utils/diagnostics';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ path: '', read: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      logs.read();
      return logs.path;
    },
  },
}));
const { buildHostNativeTools } = await import('./_host-native-tools');
const { runQueryDiagnostics } = await import('../../assistant-server/query-diagnostics-tool');
beforeEach(async () => {
  logs.path = await mkdtemp(join(tmpdir(), 'diagnostic-reader-'));
  logs.read.mockClear();
});
afterEach(async () => {
  await rm(logs.path, { force: true, recursive: true });
});
function event(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    appVersion: '1.0.0',
    causeChain: null,
    code: 'provider_failed',
    context: null,
    fingerprint: 'fp-provider',
    id: 'event-1',
    message: 'Provider failed',
    occurredAt: 5000,
    platform: 'darwin',
    resourceId: null,
    rootId: 'root-1',
    runId: 'run-1',
    scope: 'Assistant',
    sessionId: 'session-1',
    severity: 'error',
    source: 'electron-main',
    stack: null,
    threadId: 'thread-1',
    ...overrides,
  };
}
async function write(events: readonly DiagnosticEvent[], suffix = ''): Promise<void> {
  await writeFile(
    join(logs.path, `brainstrike-errors.ndjson${suffix}`),
    `${events.map(serializeDiagnosticEventLine).join('\n')}\n`
  );
}
it('registers the canonical native tool', () => {
  expect(buildHostNativeTools({}, { ids: [NATIVE_TOOL_ID.queryDiagnostics] })).toHaveProperty(
    NATIVE_TOOL_ID.queryDiagnostics
  );
});
it('reads retained rotated records with exact filters and newest-first order', async () => {
  await write([
    event(),
    event({ id: 'other-run', runId: 'other' }),
    event({ id: 'old', occurredAt: 500 }),
  ]);
  await write(
    [event({ id: 'newest', occurredAt: 5500 }), event({ id: 'warn', severity: 'warn' })],
    '.1'
  );
  const result = await runQueryDiagnostics({
    fingerprint: 'fp-provider',
    limit: 25,
    mode: 'events',
    runId: 'run-1',
    severity: 'error',
    since: new Date(1000).toISOString(),
    threadId: 'thread-1',
    until: new Date(6000).toISOString(),
  });
  expect(result.items.map((item) => ('id' in item ? item.id : null))).toEqual([
    'newest',
    'event-1',
  ]);
  expect(result.truncated).toBe(false);
});
it('scrubs secret-shaped content from projected event fields', async () => {
  await write([
    event({
      context: { apiKey: 'sk-test-secret-value' },
      message: 'apiKey=sk-test-secret-value',
      stack: 'authorization=Bearer sk-test-secret-value',
    }),
  ]);
  expect(JSON.stringify(await runQueryDiagnostics({ mode: 'events' }))).not.toContain(
    'sk-test-secret-value'
  );
});
it('rejects invalid and reversed time bounds before reading the log owner', async () => {
  await expect(runQueryDiagnostics({ mode: 'events', since: 'bad' })).rejects.toThrow(
    'since must be a valid ISO-8601 timestamp'
  );
  await expect(
    runQueryDiagnostics({
      mode: 'events',
      since: new Date(6000).toISOString(),
      until: new Date(5000).toISOString(),
    })
  ).rejects.toThrow('since must be earlier');
  expect(logs.read).not.toHaveBeenCalled();
});
it('groups retained events and reports output-budget truncation', async () => {
  await write(
    Array.from({ length: 20 }, (_, index) =>
      event({ fingerprint: `fp-${index}`, id: `id-${index}`, message: 'x'.repeat(12_000) })
    )
  );
  const result = await runQueryDiagnostics({ limit: 20, mode: 'fingerprints' });
  expect(result.truncated).toBe(true);
  expect(result.returned).toBeLessThan(20);
  expect(result.hint).toMatch(/output budget/i);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(11_000);
});
it('groups across rotation using latest matching event and exact count', async () => {
  await write([event({ id: 'new', message: 'latest', occurredAt: 8000 })]);
  await write([event()], '.1');
  const result = await runQueryDiagnostics({ mode: 'fingerprints' });
  expect(result.items).toMatchObject([
    { count: 2, firstSeenMs: 5000, lastSeenMs: 8000, latestMessage: 'latest' },
  ]);
});
it('reports malformed retained data instead of pretending the query succeeded', async () => {
  await writeFile(join(logs.path, 'brainstrike-errors.ndjson'), 'broken\n');
  await expect(runQueryDiagnostics({ mode: 'events' })).rejects.toThrow(
    'Malformed diagnostic record'
  );
});
it('returns empty for a fresh profile with no retained log', async () => {
  expect((await runQueryDiagnostics({ mode: 'events' })).items).toEqual([]);
});

it('serves full scrubbed retained events and seven-day fingerprint counts to the debug bundle', async () => {
  const { mainDiagnosticEventsReader } = await import(
    '../../assistant-server/query-diagnostics-tool'
  );
  const now = Date.now();
  const older = now - 6 * 24 * 60 * 60 * 1000;
  await write([
    event({ context: { apiKey: 'sk-test-secret-value' }, id: 'current', occurredAt: now }),
  ]);
  await write([event({ id: 'six-days', occurredAt: older, runId: 'earlier-run' })], '.1');
  const events = await mainDiagnosticEventsReader.queryEvents({ limit: 1, runId: 'run-1' });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ appVersion: '1.0.0', id: 'current', platform: 'darwin' });
  expect(JSON.stringify(events)).not.toContain('sk-test-secret-value');
  expect(
    await mainDiagnosticEventsReader.countByFingerprint(
      'fp-provider',
      now - 7 * 24 * 60 * 60 * 1000
    )
  ).toEqual({ count: 2, firstSeenMs: older, lastSeenMs: now });
});

it('counts all retained unseen diagnostics strictly after the watermark without the event-page cap', async () => {
  const { mainDiagnosticEventsReader } = await import(
    '../../assistant-server/query-diagnostics-tool'
  );
  await write([
    event({ id: 'at-watermark', occurredAt: 1000 }),
    event({ id: 'old', occurredAt: 999, severity: 'warn' }),
    ...Array.from({ length: 205 }, (_, index) =>
      event({ id: `error-${index}`, occurredAt: 1001 + index })
    ),
  ]);
  await write(
    [
      event({ id: 'fatal', occurredAt: 2000, severity: 'fatal' }),
      event({ id: 'warning', occurredAt: 2001, severity: 'warn' }),
    ],
    '.1'
  );
  expect(await mainDiagnosticEventsReader.getUnseenCounts(1000)).toEqual({
    errorCount: 206,
    warningCount: 1,
  });
  expect(await mainDiagnosticEventsReader.getUnseenCounts(2001)).toEqual({
    errorCount: 0,
    warningCount: 0,
  });
});
