import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DB_EXPLORER_SRC_DIR = resolve(import.meta.dirname, '..');
const OLD_PGLITE_UI_ALIASES = [
  'usePGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;

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
      const source = await readFile(file, 'utf8');
      for (const alias of OLD_PGLITE_UI_ALIASES) {
        if (source.includes(alias)) {
          matches.push(`${file.replace(`${DB_EXPLORER_SRC_DIR}/`, '')}: ${alias}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
