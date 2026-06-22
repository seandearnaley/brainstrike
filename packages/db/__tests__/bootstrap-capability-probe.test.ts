import { describe, expect, it } from 'vitest';
import {
  formatBootstrapCapabilityProbeReportAsMarkdown,
  runPgliteBootstrapCapabilityProbe,
} from '../src/bootstrap/bootstrap-capability-probe.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('bootstrap capability probe', () => {
  it('proves the current PGlite runtime with explicit bootstrap capability checks', async () => {
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
        expect.objectContaining({ id: 'capability.transaction', required: true, status: 'passed' }),
        expect.objectContaining({ id: 'capability.live-query', required: true, status: 'passed' }),
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
  });

  it('renders a compact Markdown report from the JSON report', async () => {
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

  it('fails closed when the selected current-runtime store cannot close', async () => {
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
  });
});
