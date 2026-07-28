import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import {
  DIAGNOSTIC_RETENTION_MAX_ROWS,
  DiagnosticEventsRepository,
} from '../src/repositories/diagnostic-events-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

function makeEvent(overrides: Partial<DiagnosticEvent>): DiagnosticEvent {
  return {
    appVersion: 'v',
    causeChain: null,
    code: null,
    context: null,
    fingerprint: 'fp-default',
    id: `id-${Math.random().toString(36).slice(2)}`,
    message: 'message',
    occurredAt: Date.now(),
    platform: 'test',
    resourceId: null,
    rootId: null,
    runId: null,
    scope: 'Scope',
    sessionId: 'session',
    severity: 'error',
    source: 'web-renderer',
    stack: null,
    threadId: null,
    ...overrides,
  };
}

describe('DiagnosticEventsRepository', () => {
  let db: PGlite;
  let repo: DiagnosticEventsRepository;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-diagnostic-repo');
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    repo = new DiagnosticEventsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('inserts a batch and queries by filters newest-first', async () => {
    await repo.insertBatch([
      makeEvent({ id: 'a', occurredAt: 1000, severity: 'warn', threadId: 't1' }),
      makeEvent({ id: 'b', occurredAt: 2000, severity: 'error', threadId: 't1' }),
      makeEvent({ id: 'c', occurredAt: 3000, severity: 'error', threadId: 't2' }),
    ]);
    const rows = await repo.queryEvents({ severity: 'error', threadId: 't1' });
    expect(rows.map((row) => row.id)).toEqual(['b']);
    const all = await repo.queryEvents({});
    expect(all.map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('counts occurrences by fingerprint with first/last seen', async () => {
    await repo.insertBatch([
      makeEvent({ fingerprint: 'fp-x', id: 'a', occurredAt: 1000 }),
      makeEvent({ fingerprint: 'fp-x', id: 'b', occurredAt: 5000 }),
      makeEvent({ fingerprint: 'fp-y', id: 'c', occurredAt: 2000 }),
    ]);
    const stats = await repo.countByFingerprint('fp-x', 0);
    expect(stats).toEqual({ count: 2, firstSeenMs: 1000, lastSeenMs: 5000 });
  });

  it('groups recurring diagnostics by fingerprint with bounded filters and latest context', async () => {
    await repo.insertBatch([
      makeEvent({
        code: 'provider_failed',
        fingerprint: 'fp-x',
        id: 'a',
        message: 'first failure',
        occurredAt: 1000,
        runId: 'run-1',
        severity: 'error',
        source: 'electron-main',
        threadId: 'thread-1',
      }),
      makeEvent({
        code: 'provider_failed',
        fingerprint: 'fp-x',
        id: 'b',
        message: 'latest failure',
        occurredAt: 5000,
        runId: 'run-1',
        severity: 'error',
        source: 'electron-main',
        threadId: 'thread-1',
      }),
      makeEvent({
        fingerprint: 'fp-y',
        id: 'c',
        occurredAt: 2000,
        runId: 'run-2',
        severity: 'warn',
        threadId: 'thread-2',
      }),
    ]);

    const groups = await repo.queryFingerprintGroups({
      runId: 'run-1',
      severity: 'error',
      sinceMs: 500,
      untilMs: 6000,
    });

    expect(groups).toEqual([
      {
        code: 'provider_failed',
        count: 2,
        fingerprint: 'fp-x',
        firstSeenMs: 1000,
        lastSeenMs: 5000,
        latestMessage: 'latest failure',
        severity: 'error',
        source: 'electron-main',
      },
    ]);
  });

  it('purges beyond the age bound oldest-first and reports the count', async () => {
    const now = Date.now();
    await repo.insertBatch([
      makeEvent({ id: 'old', occurredAt: now - 40 * 24 * 60 * 60 * 1000 }),
      makeEvent({ id: 'fresh', occurredAt: now }),
    ]);
    const deleted = await repo.purge();
    expect(deleted).toBe(1);
    const rows = await repo.queryEvents({});
    expect(rows.map((row) => row.id)).toEqual(['fresh']);
  });

  it('purges beyond the row bound oldest-first', async () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      makeEvent({ id: `e${index}`, occurredAt: 1000 + index })
    );
    await repo.insertBatch(events);
    const deleted = await repo.purge({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxRows: 4 });
    expect(deleted).toBe(6);
    const rows = await repo.queryEvents({});
    expect(rows).toHaveLength(4);
    expect(rows[0]?.id).toBe('e9');
    expect(DIAGNOSTIC_RETENTION_MAX_ROWS).toBe(20_000);
  });
});
