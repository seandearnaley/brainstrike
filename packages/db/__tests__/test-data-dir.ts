import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const trackedPGliteTestDataDirs = new Set<string>();

export function createPGliteTestDataDir(prefix: string): string {
  const dataDir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  trackedPGliteTestDataDirs.add(dataDir);
  return dataDir;
}

export async function cleanupPGliteTestDataDirs(): Promise<void> {
  const dataDirs = [...trackedPGliteTestDataDirs];
  trackedPGliteTestDataDirs.clear();

  for (const dataDir of dataDirs) {
    await rm(dataDir, { force: true, recursive: true });
  }
}

afterEach(async () => {
  await cleanupPGliteTestDataDirs();
});
