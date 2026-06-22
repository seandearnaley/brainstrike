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
    'reports local Turso runtime capabilities and requires a split search index architecture',
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
        expect(report.bootstrapReport.ready).toBe(true);
        expect(report.bootstrapReport.phase).toBe('ready');
        expect(report.bootstrapReport.runtime).toEqual({
          engine: 'turso',
          host: 'node',
          persistence: 'filesystem',
        });
        expect(report.blockingIssues).toEqual([]);
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
          'architecture.split-search-index',
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
              required: false,
              status: 'failed',
              message:
                'failed to consume stmt: Parse error: Custom index modules are not supported in MVCC mode',
            }),
            expect.objectContaining({
              id: 'architecture.split-search-index',
              required: true,
              status: 'passed',
              message:
                'Turso FTS and MVCC are both available but cannot share one MVCC-enabled database file; Brainstrike must use an explicitly owned search-index store or equivalent non-FTS search implementation.',
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
          '| `search.fts-mvcc-compatibility` | Optional | `failed` | failed to consume stmt: Parse error: Custom index modules are not supported in MVCC mode |'
        );
        expect(markdown).toContain(
          '| `architecture.split-search-index` | Required | `passed` | Turso FTS and MVCC are both available but cannot share one MVCC-enabled database file; Brainstrike must use an explicitly owned search-index store or equivalent non-FTS search implementation. |'
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
