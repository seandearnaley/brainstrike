import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VECTOR_MANAGEMENT_SRC_DIR = resolve(import.meta.dirname, '..');
const PGLITE_IMPORT_MARKERS = [
  '@electric-sql/pglite',
  'usePGliteDatabase',
  'useOptionalPGliteDatabase',
] as const;
const PGLITE_ONLY_CONSUMERS = new Set([
  'embedding-job-queue-tracker.tsx',
  'indexing-activity-coordinator.tsx',
  'queue-hud.tsx',
]);
const PGLITE_CAPABILITY_CONSUMERS = new Set(['collection-select/collection-select.tsx']);

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') {
          return [];
        }
        return listSourceFiles(path);
      }
      if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
        return [path];
      }
      return [];
    })
  );
  return files.flat();
}

describe('vector management database imports', () => {
  it('uses generic DB handle types in production consumers', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(VECTOR_MANAGEMENT_SRC_DIR)) {
      const relativeFile = file.replace(`${VECTOR_MANAGEMENT_SRC_DIR}/`, '');
      const source = await readFile(file, 'utf8');
      for (const marker of PGLITE_IMPORT_MARKERS) {
        if (source.includes(marker)) {
          if (
            (marker === 'usePGliteDatabase' && PGLITE_ONLY_CONSUMERS.has(relativeFile)) ||
            (marker === 'useOptionalPGliteDatabase' &&
              PGLITE_CAPABILITY_CONSUMERS.has(relativeFile))
          ) {
            continue;
          }
          matches.push(`${relativeFile}: ${marker}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
