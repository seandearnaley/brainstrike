import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SETTINGS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PREFERENCES_SRC_DIR = dirname(SETTINGS_DIR);
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

describe('settings database hook imports', () => {
  it('uses generic DB client and live query aliases in UI consumers', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(PREFERENCES_SRC_DIR)) {
      const source = await readFile(file, 'utf8');
      for (const alias of OLD_PGLITE_UI_ALIASES) {
        if (source.includes(alias)) {
          matches.push(`${file.replace(`${PREFERENCES_SRC_DIR}/`, '')}: ${alias}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
