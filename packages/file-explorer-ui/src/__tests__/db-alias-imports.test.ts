import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE_EXPLORER_UI_SRC_DIR = resolve(import.meta.dirname, '..');
const OLD_PGLITE_DB_ALIASES = [
  'usePGliteDatabase',
  'useOptionalPGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;
const OLD_PGLITE_IMPORT_PATTERN = new RegExp(
  `import\\s*\\{[^}]*\\b(?:${OLD_PGLITE_DB_ALIASES.join('|')})\\b[^}]*\\}\\s*from\\s*['"]@brainstrike/db['"]`
);

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

describe('file explorer UI database hook imports', () => {
  it('uses generic DB client aliases in production consumers and tests', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(FILE_EXPLORER_UI_SRC_DIR)) {
      const relativePath = relative(FILE_EXPLORER_UI_SRC_DIR, file);
      const parts = relativePath.split(sep);
      if (
        file === resolve(import.meta.filename) ||
        (parts.includes('__tests__') && parts.includes('setup'))
      ) {
        continue;
      }

      const source = await readFile(file, 'utf8');
      if (OLD_PGLITE_IMPORT_PATTERN.test(source)) {
        matches.push(relativePath);
      }
    }

    expect(matches).toEqual([]);
  });
});
