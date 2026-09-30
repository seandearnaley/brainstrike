// @vitest-environment node
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: undefined }));

// The real factory, real migrations and the real `@brainstrike/db` rebuild: the mocked suite
// (`db-main.crash-recovery.test.ts`) proves the ordering, this proves the wiring runs on a real handle.
it('rebuilds the real BM25 index on the first open after an unclean shutdown, and only then', async () => {
  // OS temp dir: a real PGlite data dir must never land in the checkout, even on a hard kill.
  const root = await mkdtemp(path.join(tmpdir(), 'pglite-crash-recovery-test-'));
  const parentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: { on: vi.fn(), postMessage: vi.fn() },
  });
  vi.stubEnv('BRAINSTRIKE_DB_ROOT_PATH', root);
  vi.stubEnv('BRAINSTRIKE_DB_PROFILE', 'crash-recovery-test');
  const { closeDatabase, getDatabase, getDatabaseDiagnostics, initializeMainDatabase } =
    await import('../../db-main');
  try {
    await getDatabase();
    expect(getDatabaseDiagnostics()).toMatchObject({
      crashRecoveryIndexRebuild: null,
      previousShutdown: 'new-database',
    });

    // A session that never wrote its marker is what a crash leaves behind.
    await closeDatabase();
    await unlink(path.join(getDatabaseDiagnostics().appDataDir, '.db-clean-shutdown'));
    const reports: DatabaseInitPhaseReport[] = [];
    await initializeMainDatabase({ onPhase: (report) => reports.push(report) });
    const afterCrash = getDatabaseDiagnostics();
    expect(afterCrash.previousShutdown).toBe('unclean');
    expect(afterCrash.crashRecoveryIndexRebuild?.rebuilt).toEqual([
      {
        accessMethod: 'bm25',
        durationMs: expect.any(Number),
        heapBytes: expect.any(Number),
        index: 'idx_file_chunks_content_bm25',
        indexBytes: expect.any(Number),
        schema: 'public',
        table: 'file_chunks',
        toastBytes: expect.any(Number),
      },
    ]);
    // The real handle reports each phase before running it, with the real on-disk sizes.
    expect(reports.map((report) => report.phase)).toEqual([
      'open-database',
      'index-rebuild',
      'migration',
    ]);
    expect(reports[0]).toEqual({ pgWalBytes: expect.any(Number), phase: 'open-database' });
    expect(reports[0]).not.toMatchObject({ pgWalBytes: 0 });
    expect(reports[1]).toMatchObject({
      index: { index: 'idx_file_chunks_content_bm25', schema: 'public', table: 'file_chunks' },
      phase: 'index-rebuild',
    });

    await closeDatabase();
    await getDatabase();
    expect(getDatabaseDiagnostics()).toMatchObject({
      crashRecoveryIndexRebuild: null,
      previousShutdown: 'clean',
    });
  } finally {
    await closeDatabase();
    vi.unstubAllEnvs();
    if (parentPort) {
      Object.defineProperty(process, 'parentPort', parentPort);
    } else {
      Reflect.deleteProperty(process, 'parentPort');
    }
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
