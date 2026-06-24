import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_SHELL_SRC_DIR = resolve(import.meta.dirname, '..');
const OLD_PGLITE_UI_ALIASES = [
  'usePGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;
const PGLITE_ONLY_CONSUMERS = new Set([
  'background-indexing/workspace-collection-sync-provider.tsx',
]);

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

describe('app shell database hook imports', () => {
  it('uses generic DB client and live query aliases in production consumers', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(APP_SHELL_SRC_DIR)) {
      const relativeFile = file.replace(`${APP_SHELL_SRC_DIR}/`, '');
      const source = await readFile(file, 'utf8');
      for (const alias of OLD_PGLITE_UI_ALIASES) {
        if (source.includes(alias)) {
          if (alias === 'usePGliteDatabase' && PGLITE_ONLY_CONSUMERS.has(relativeFile)) {
            continue;
          }
          matches.push(`${relativeFile}: ${alias}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
