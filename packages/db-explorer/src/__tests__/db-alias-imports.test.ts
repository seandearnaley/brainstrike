import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DB_EXPLORER_SRC_DIR = resolve(import.meta.dirname, '..');
const OLD_PGLITE_UI_ALIASES = [
  'usePGliteDatabase',
  'useOptionalPGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;
const PGLITE_ONLY_CONSUMERS = new Set([
  '__tests__/enhanced-file-import-service.test.ts',
  'enhanced-file-import-service.ts',
]);
const PGLITE_CAPABILITY_CONSUMERS = new Set([
  '__tests__/database-demo-panel.test.tsx',
  'hooks/__tests__/use-collection-embedding-coverage.test.ts',
  'hooks/use-collection-embedding-coverage.ts',
]);

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
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

describe('db explorer database hook imports', () => {
  it('uses generic DB client and live query aliases in production consumers and tests', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(DB_EXPLORER_SRC_DIR)) {
      if (file === resolve(import.meta.filename)) {
        continue;
      }
      const relativeFile = file.replace(`${DB_EXPLORER_SRC_DIR}/`, '');
      const source = await readFile(file, 'utf8');
      for (const alias of OLD_PGLITE_UI_ALIASES) {
        if (source.includes(alias)) {
          if (
            (alias === 'usePGliteDatabase' && PGLITE_ONLY_CONSUMERS.has(relativeFile)) ||
            (alias === 'useOptionalPGliteDatabase' && PGLITE_CAPABILITY_CONSUMERS.has(relativeFile))
          ) {
            continue;
          }
          matches.push(`${relativeFile}: ${alias}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
