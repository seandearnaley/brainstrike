import { describe, expect, it, vi } from 'vitest';
import { runTursoProfileBootstrap } from '../src/bootstrap/turso-profile-bootstrap.js';

describe('Turso profile bootstrap', () => {
  it('opens the primary store in MVCC mode and declares split search ownership', async () => {
    const pragmaSql: string[] = [];
    const close = vi.fn(async () => undefined);
    const database = {
      close,
      pragma: async (source: string) => {
        pragmaSql.push(source);
        return [{ journal_mode: 'mvcc' }];
      },
    };

    const report = await runTursoProfileBootstrap({
      dbPath: '/tmp/brainstrike-turso/profile.db',
      generatedAt: createClock(),
      openDatabase: async (dbPath) => {
        expect(dbPath).toBe('/tmp/brainstrike-turso/profile.db');
        return database;
      },
      profileId: 'branch-turso',
    });

    expect(pragmaSql).toEqual(["journal_mode = 'mvcc'"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(report.bootstrapReport).toMatchObject({
      phase: 'ready',
      profileId: 'branch-turso',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'node',
        persistence: 'filesystem',
      },
      search: {
        indexedSearch: 'available',
        ownershipMode: 'split-search-index-store',
      },
    });
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'store.open', status: 'passed' }),
      expect.objectContaining({ id: 'primary-store.mvcc', status: 'passed' }),
      expect.objectContaining({ id: 'search.ownership', status: 'passed' }),
      expect.objectContaining({ id: 'store.close', status: 'passed' }),
    ]);
    expect(report.blockingIssues).toEqual([]);
  });

  it('fails closed when MVCC mode returns a different applied journal mode', async () => {
    const close = vi.fn(async () => undefined);
    const database = {
      close,
      pragma: async () => [{ journal_mode: 'wal' }],
    };

    const report = await runTursoProfileBootstrap({
      dbPath: '/tmp/brainstrike-turso/profile.db',
      generatedAt: createClock(),
      openDatabase: async () => database,
      profileId: 'branch-turso',
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_profile_bootstrap_failed',
        message: "Turso journal_mode pragma returned 'wal' instead of 'mvcc'.",
        phase: 'probing-capabilities',
      },
      phase: 'failed',
      ready: false,
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'primary-store.mvcc',
        message: "Turso journal_mode pragma returned 'wal' instead of 'mvcc'.",
        status: 'failed',
      })
    );
  });

  it('fails closed when MVCC cannot be enabled', async () => {
    const close = vi.fn(async () => undefined);
    const database = {
      close,
      pragma: async () => {
        throw new Error('failed to enable MVCC at /tmp/private/profile.db');
      },
    };

    const report = await runTursoProfileBootstrap({
      dbPath: '/tmp/private/profile.db',
      generatedAt: createClock(),
      openDatabase: async () => database,
      profileId: 'branch-turso',
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_profile_bootstrap_failed',
        message: 'failed to enable MVCC at <path>',
        phase: 'probing-capabilities',
      },
      phase: 'failed',
      ready: false,
      search: {
        indexedSearch: 'available',
        ownershipMode: 'split-search-index-store',
      },
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'primary-store.mvcc',
        message: 'failed to enable MVCC at <path>',
        status: 'failed',
      })
    );
    expect(report.blockingIssues).toEqual([
      {
        checkId: null,
        message: 'Bootstrap failed during probing-capabilities: failed to enable MVCC at <path>',
        phase: 'failed',
        severity: 'blocking',
      },
    ]);
  });
});

function createClock(): () => string {
  const timestamps = [
    '2026-06-22T00:00:00.000Z',
    '2026-06-22T00:00:01.000Z',
    '2026-06-22T00:00:02.000Z',
  ];
  let index = 0;
  return () => timestamps[index++] ?? timestamps.at(-1) ?? '2026-06-22T00:00:02.000Z';
}
