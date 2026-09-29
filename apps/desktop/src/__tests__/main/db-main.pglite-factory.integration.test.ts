// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: undefined }));

it('boots the desktop DB host with the real factory and complete migrated extension set', async () => {
  // OS temp dir: a real PGlite data dir must never land in the checkout, even on a hard kill.
  const root = await mkdtemp(path.join(tmpdir(), 'pglite-factory-test-'));
  const parentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: { on: vi.fn(), postMessage: vi.fn() },
  });
  vi.stubEnv('BRAINSTRIKE_DB_ROOT_PATH', root);
  vi.stubEnv('BRAINSTRIKE_DB_PROFILE', 'factory-test');
  const { closeDatabase, getDatabase } = await import('../../db-main');
  try {
    const db = await getDatabase();
    const { rows } = await db.query<{ extname: string }>(
      'SELECT extname FROM pg_extension ORDER BY extname'
    );
    expect(rows.map(({ extname }) => extname)).toEqual([
      'pg_textsearch',
      'pg_trgm',
      'plpgsql',
      'vector',
    ]);
    const live = await db.live.query('SELECT 1 AS value');
    await live.unsubscribe();
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
}, 30_000);
