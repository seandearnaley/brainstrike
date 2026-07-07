import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

const trackedPGliteTestDataDirs = new Set<string>();

interface PGliteTestDataDirOptions {
  autoCleanup?: boolean;
}

export function createPGliteTestDataDir(
  prefix: string,
  options: PGliteTestDataDirOptions = {}
): string {
  const dataDir = path.join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  );
  trackedPGliteTestDataDirs.add(dataDir);

  if (options.autoCleanup !== false) {
    onTestFinished(async () => {
      await cleanupPGliteTestDataDir(dataDir);
    });
  }

  return dataDir;
}

export async function cleanupPGliteTestDataDirs(): Promise<void> {
  const dataDirs = [...trackedPGliteTestDataDirs];
  trackedPGliteTestDataDirs.clear();

  for (const dataDir of dataDirs) {
    await cleanupPGliteTestDataDir(dataDir);
  }
}

async function cleanupPGliteTestDataDir(dataDir: string): Promise<void> {
  trackedPGliteTestDataDirs.delete(dataDir);
  await rm(dataDir, { force: true, recursive: true });
}
