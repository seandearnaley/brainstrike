import { wasmLoader } from '@brainstrike/db';
import { onTestFinished } from 'vitest';

type TestPGlite = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

export async function createTestPGlite(dataDir: string): Promise<TestPGlite> {
  const db = await wasmLoader.createPGlite(dataDir);
  onTestFinished(async () => {
    // memory:// instances are not cached. The test owns the returned handle.
    if (db.closed) {
      return;
    }
    await db.close();
  });
  return db;
}
