import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatBootstrapCapabilityProbeReportAsMarkdown,
  runPgliteBootstrapCapabilityProbe,
} from '../src/bootstrap/bootstrap-capability-probe.js';
import { wasmLoader } from '../src/wasm-loader.js';

const PGLITE_CAPABILITY_PROBE_TEST_TIMEOUT_MS = 30_000;

describe('bootstrap capability probe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'proves the current PGlite runtime with explicit bootstrap capability checks',
    async () => {
      const report = await runPgliteBootstrapCapabilityProbe({
        dataDir: `memory://bootstrap-capability-probe-${Date.now()}`,
        generatedAt: () => '2026-06-22T00:00:00.000Z',
        profileId: 'probe-test',
      });

      expect(report.reportVersion).toBe(1);
      expect(report.generatedAt).toBe('2026-06-22T00:00:00.000Z');
      expect(report.bootstrapReport.ready).toBe(true);
      expect(report.bootstrapReport.runtime).toEqual({
        engine: 'pglite',
        host: 'node',
        persistence: 'memory',
      });
      expect(report.blockingIssues).toEqual([]);
      expect(report.checks.map((check) => check.id)).toEqual([
        'store.open',
        'schema.migrated',
        'extension.pgvector',
        'extension.pg_trgm',
        'search.fts-grep',
        'capability.transaction',
        'capability.live-query',
        'queue.table',
        'assistant-memory.run-usage',
        'assistant-memory.mastra-schema',
        'workspace-index.system-role',
        'store.close',
      ]);
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'store.open', required: true, status: 'passed' }),
          expect.objectContaining({ id: 'schema.migrated', required: true, status: 'passed' }),
          expect.objectContaining({ id: 'extension.pgvector', required: true, status: 'passed' }),
          expect.objectContaining({ id: 'extension.pg_trgm', required: true, status: 'passed' }),
          expect.objectContaining({ id: 'search.fts-grep', required: true, status: 'passed' }),
          expect.objectContaining({
            id: 'capability.transaction',
            required: true,
            status: 'passed',
          }),
          expect.objectContaining({
            id: 'capability.live-query',
            required: true,
            status: 'passed',
          }),
          expect.objectContaining({ id: 'queue.table', required: true, status: 'passed' }),
          expect.objectContaining({
            id: 'assistant-memory.run-usage',
            required: true,
            status: 'passed',
          }),
          expect.objectContaining({
            id: 'assistant-memory.mastra-schema',
            required: false,
            status: 'skipped',
          }),
          expect.objectContaining({
            id: 'workspace-index.system-role',
            required: true,
            status: 'passed',
          }),
          expect.objectContaining({ id: 'store.close', required: true, status: 'passed' }),
        ])
      );
    },
    PGLITE_CAPABILITY_PROBE_TEST_TIMEOUT_MS
  );

  it(
    'renders a compact Markdown report from the JSON report',
    async () => {
      const report = await runPgliteBootstrapCapabilityProbe({
        dataDir: `memory://bootstrap-capability-probe-markdown-${Date.now()}`,
        generatedAt: () => '2026-06-22T00:00:00.000Z',
        profileId: 'markdown-test',
      });

      const markdown = formatBootstrapCapabilityProbeReportAsMarkdown(report);

      expect(markdown).toContain('# Brainstrike Bootstrap Capability Probe');
      expect(markdown).toContain('Runtime: `pglite` on `node` using `memory` persistence');
      expect(markdown).toContain('| `store.open` | Required | `passed` |');
      expect(markdown).toContain('| `assistant-memory.mastra-schema` | Optional | `skipped` |');
      expect(markdown).not.toContain('memory://bootstrap-capability-probe-markdown');
    },
    PGLITE_CAPABILITY_PROBE_TEST_TIMEOUT_MS
  );

  it('evicts cached IndexedDB default-opener handles when closing the probe', async () => {
    const fakeDb = {
      close: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
    const openSpy = vi.spyOn(wasmLoader, 'createPGlite').mockResolvedValue(fakeDb);
    const closeCachedSpy = vi.spyOn(wasmLoader, 'closeCached').mockResolvedValue(undefined);

    const report = await runPgliteBootstrapCapabilityProbe({
      dataDir: 'idb://bootstrap-capability-probe-cache',
      generatedAt: () => '2026-06-22T00:00:00.000Z',
      profileId: 'cached-idb-profile',
      runMigrations: async () => ({
        appliedMigrations: [],
        error: 'stop before capability probes',
        success: false,
      }),
    });

    expect(openSpy).toHaveBeenCalledWith('idb://bootstrap-capability-probe-cache');
    expect(closeCachedSpy).toHaveBeenCalledWith('idb://bootstrap-capability-probe-cache', {
      throwOnCloseError: true,
    });
    expect(fakeDb.close).not.toHaveBeenCalled();
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'schema.migrated', status: 'failed' }),
        expect.objectContaining({ id: 'store.close', required: true, status: 'passed' }),
      ])
    );
  });

  it('fails closed when cached IndexedDB default-opener handles cannot close', async () => {
    const fakeDb = {
      close: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
    vi.spyOn(wasmLoader, 'createPGlite').mockResolvedValue(fakeDb);
    const closeCachedSpy = vi
      .spyOn(wasmLoader, 'closeCached')
      .mockRejectedValue(new Error('could not close /tmp/brainstrike/profile.db'));

    const report = await runPgliteBootstrapCapabilityProbe({
      dataDir: 'idb://bootstrap-capability-probe-cache-close-failure',
      generatedAt: () => '2026-06-22T00:00:00.000Z',
      profileId: 'cached-idb-close-failure-profile',
      runMigrations: async () => ({
        appliedMigrations: [],
        error: 'stop before capability probes',
        success: false,
      }),
    });

    expect(closeCachedSpy).toHaveBeenCalledWith(
      'idb://bootstrap-capability-probe-cache-close-failure',
      { throwOnCloseError: true }
    );
    expect(report.bootstrapReport.ready).toBe(false);
    expect(report.bootstrapReport.phase).toBe('blocked');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'store.close', required: true, status: 'failed' }),
      ])
    );
    expect(report.blockingIssues.map((issue) => issue.message)).toContain(
      'Required bootstrap check failed: Selected profile store closes cleanly'
    );
  });

  it('fails closed when the selected current-runtime store cannot open', async () => {
    const report = await runPgliteBootstrapCapabilityProbe({
      dataDir: 'memory://unused',
      generatedAt: () => '2026-06-22T00:00:00.000Z',
      openDatabase: async () => {
        throw new Error('could not open /tmp/brainstrike/profile.db');
      },
      profileId: 'broken-profile',
    });

    expect(report.bootstrapReport.ready).toBe(false);
    expect(report.bootstrapReport.phase).toBe('failed');
    expect(report.bootstrapReport.failure).toMatchObject({
      message: 'could not open <path>',
      phase: 'opening-store',
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'store.open', required: true, status: 'failed' }),
        expect.objectContaining({ id: 'schema.migrated', required: true, status: 'pending' }),
      ])
    );
    expect(report.blockingIssues.map((issue) => issue.message)).toContain(
      'Bootstrap failed during opening-store: could not open <path>'
    );
  });

  it('fails closed on migration result failure without running downstream capability probes', async () => {
    let capabilityProbeQueryCount = 0;
    const report = await runPgliteBootstrapCapabilityProbe({
      dataDir: `memory://bootstrap-capability-probe-migration-failure-${Date.now()}`,
      generatedAt: () => '2026-06-22T00:00:00.000Z',
      openDatabase: async (dataDir) => {
        const db = await wasmLoader.createPGlite(dataDir);
        const originalQuery = db.query.bind(db);
        (db as unknown as { query: typeof db.query }).query = async (sql, params) => {
          const sqlText = String(sql);
          if (
            sqlText.includes('pg_extension') ||
            sqlText.includes('pg_indexes') ||
            sqlText.includes('information_schema') ||
            sqlText.includes('SELECT 1 AS ok')
          ) {
            capabilityProbeQueryCount += 1;
          }
          return originalQuery(sql, params);
        };
        return db;
      },
      profileId: 'migration-failure-profile',
      runMigrations: async () => ({
        appliedMigrations: ['0000_probe_setup'],
        error: 'CREATE EXTENSION vector failed in migration 0001',
        success: false,
      }),
    });

    expect(capabilityProbeQueryCount).toBe(0);
    expect(report.bootstrapReport.ready).toBe(false);
    expect(report.bootstrapReport.phase).toBe('blocked');
    expect(report.bootstrapReport.failure).toBeNull();
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'schema.migrated',
          message:
            'Schema migration failed after 1 migration(s): CREATE EXTENSION vector failed in migration 0001',
          required: true,
          status: 'failed',
        }),
        expect.objectContaining({ id: 'extension.pgvector', status: 'pending' }),
        expect.objectContaining({ id: 'store.close', status: 'passed' }),
      ])
    );
    expect(report.blockingIssues.map((issue) => issue.message)).toContain(
      'Required bootstrap check failed: Schema migrations complete'
    );
  });

  it('attributes thrown capability probes to the in-flight check id', async () => {
    const report = await runPgliteBootstrapCapabilityProbe({
      dataDir: `memory://bootstrap-capability-probe-queue-throw-${Date.now()}`,
      generatedAt: () => '2026-06-22T00:00:00.000Z',
      openDatabase: async (dataDir) => {
        const db = await wasmLoader.createPGlite(dataDir);
        const originalQuery = db.query.bind(db);
        (db as unknown as { query: typeof db.query }).query = async (sql, params) => {
          if (Array.isArray(params) && params[0] === 'job_queue') {
            throw new Error('job_queue catalog lookup failed');
          }
          return originalQuery(sql, params);
        };
        return db;
      },
      profileId: 'queue-throw-profile',
    });

    expect(report.bootstrapReport.ready).toBe(false);
    expect(report.bootstrapReport.phase).toBe('failed');
    expect(report.bootstrapReport.failure).toMatchObject({
      message: 'job_queue catalog lookup failed',
      phase: 'probing-capabilities',
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'extension.pgvector', status: 'passed' }),
        expect.objectContaining({ id: 'queue.table', required: true, status: 'failed' }),
      ])
    );
    expect(report.blockingIssues.map((issue) => issue.message)).toContain(
      'Bootstrap failed during probing-capabilities: job_queue catalog lookup failed'
    );
  });

  it(
    'fails closed when the selected current-runtime store cannot close',
    async () => {
      const report = await runPgliteBootstrapCapabilityProbe({
        dataDir: `memory://bootstrap-capability-probe-close-${Date.now()}`,
        generatedAt: () => '2026-06-22T00:00:00.000Z',
        openDatabase: async (dataDir) => {
          const db = await wasmLoader.createPGlite(dataDir);
          const originalClose = db.close.bind(db);
          (db as unknown as { close: () => Promise<void> }).close = async () => {
            await originalClose();
            throw new Error('could not close /tmp/brainstrike/profile.db');
          };
          return db;
        },
        profileId: 'broken-close-profile',
      });

      expect(report.bootstrapReport.ready).toBe(false);
      expect(report.bootstrapReport.phase).toBe('blocked');
      expect(report.bootstrapReport.failure).toBeNull();
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'store.open', required: true, status: 'passed' }),
          expect.objectContaining({ id: 'store.close', required: true, status: 'failed' }),
        ])
      );
      expect(report.blockingIssues.map((issue) => issue.message)).toContain(
        'Required bootstrap check failed: Selected profile store closes cleanly'
      );
    },
    PGLITE_CAPABILITY_PROBE_TEST_TIMEOUT_MS
  );
});
