// @vitest-environment node
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  const { closeDatabase, getDatabase, getDatabaseDiagnostics } = await import('../../db-main');
  try {
    await getDatabase();
    expect(getDatabaseDiagnostics()).toMatchObject({
      crashRecoveryIndexRebuild: null,
      previousShutdown: 'new-database',
    });

    // A session that never wrote its marker is what a crash leaves behind.
    await closeDatabase();
    await unlink(path.join(getDatabaseDiagnostics().appDataDir, '.db-clean-shutdown'));
    await getDatabase();
    const afterCrash = getDatabaseDiagnostics();
    expect(afterCrash.previousShutdown).toBe('unclean');
    expect(afterCrash.crashRecoveryIndexRebuild?.rebuilt).toEqual([
      {
        accessMethod: 'bm25',
        durationMs: expect.any(Number),
        index: 'idx_file_chunks_content_bm25',
        schema: 'public',
        table: 'file_chunks',
      },
    ]);

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
