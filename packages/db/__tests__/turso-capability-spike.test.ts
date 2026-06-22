import { rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatTursoCapabilitySpikeReportAsMarkdown,
  runTursoCapabilitySpike,
} from '../src/bootstrap/turso-capability-spike.js';

const TURSO_CAPABILITY_SPIKE_TIMEOUT_MS = 30_000;

describe('Turso capability spike', () => {
  it(
    'reports local Turso runtime capabilities and blocks on MVCC search-index incompatibility',
    async () => {
      const dbPath = join(tmpdir(), `brainstrike-turso-capability-spike-${Date.now()}.db`);

      try {
        await writeFile(dbPath, 'stale-db-content', 'utf8');
        const report = await runTursoCapabilitySpike({
          dbPath,
          generatedAt: () => '2026-06-22T00:00:00.000Z',
          profileId: 'turso-spike-test',
        });

        expect(report.reportVersion).toBe(1);
        expect(report.generatedAt).toBe('2026-06-22T00:00:00.000Z');
        expect(report.bootstrapReport.ready).toBe(false);
        expect(report.bootstrapReport.phase).toBe('blocked');
        expect(report.bootstrapReport.runtime).toEqual({
          engine: 'turso',
          host: 'node',
          persistence: 'filesystem',
        });
        expect(report.blockingIssues).toEqual([
          {
            checkId: 'search.fts-mvcc-compatibility',
            message:
              'Required bootstrap check failed: Turso FTS custom indexes remain usable with MVCC concurrent writes enabled',
            phase: 'blocked',
            severity: 'blocking',
          },
          {
            checkId: null,
            message: 'Bootstrap phase has not reached ready: blocked',
            phase: 'blocked',
            severity: 'blocking',
          },
        ]);
        expect(report.checks.map((check) => check.id)).toEqual([
          'package.tursodatabase-database',
          'package.tursodatabase-sync',
          'package.libsql-client',
          'package.drizzle-libsql-adapter',
          'store.open',
          'sql.crud',
          'sql.transaction',
          'sql.concurrent-writes-mvcc',
          'search.vector-distance',
          'search.fts-index',
          'search.fts-mvcc-compatibility',
          'store.close',
        ]);
        expect(report.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'package.tursodatabase-database',
              required: true,
              status: 'passed',
            }),
            expect.objectContaining({
              id: 'sql.concurrent-writes-mvcc',
              required: true,
              status: 'passed',
            }),
            expect.objectContaining({
              id: 'search.vector-distance',
              required: true,
              status: 'passed',
            }),
            expect.objectContaining({ id: 'search.fts-index', required: true, status: 'passed' }),
            expect.objectContaining({
              id: 'search.fts-mvcc-compatibility',
              required: true,
              status: 'failed',
              message:
                'failed to consume stmt: Parse error: Custom index modules are not supported in MVCC mode',
            }),
          ])
        );

        await expect(stat(dbPath)).resolves.toEqual(
          expect.objectContaining({ size: expect.any(Number) })
        );

        const markdown = formatTursoCapabilitySpikeReportAsMarkdown(report);
        expect(markdown).toContain('# Brainstrike Turso Capability Spike');
        expect(markdown).toContain('Runtime: `turso` on `node` using `filesystem` persistence');
        expect(markdown).toContain('| `sql.concurrent-writes-mvcc` | Required | `passed` |');
        expect(markdown).toContain(
          '| `search.fts-mvcc-compatibility` | Required | `failed` | failed to consume stmt: Parse error: Custom index modules are not supported in MVCC mode |'
        );
        expect(markdown).not.toContain(dbPath);
      } finally {
        await rm(dbPath, { force: true });
        await rm(`${dbPath}.fts.db`, { force: true });
      }
    },
    TURSO_CAPABILITY_SPIKE_TIMEOUT_MS
  );
});
