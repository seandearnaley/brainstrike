import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_SHELL_SRC_DIR = resolve(import.meta.dirname, '..');
const PGLITE_GATED_DB_ALIASES = [
  'useBrainstrikeDatabase',
  'useBrainstrikeDbClient',
  'useOptionalBrainstrikeDatabase',
  'useOptionalBrainstrikeDbClient',
  'usePGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;
const PGLITE_GATED_DB_IMPORT_PATTERN = new RegExp(
  `import\\s*(?:type\\s*)?\\{[^}]*\\b(?:${PGLITE_GATED_DB_ALIASES.join('|')})\\b[^}]*\\}\\s*from\\s*['"]@brainstrike/db['"]`
);
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
  it('keeps new production consumers off PGlite-gated database hooks', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(APP_SHELL_SRC_DIR)) {
      const relativeFile = relative(APP_SHELL_SRC_DIR, file).split(sep).join('/');
      const source = await readFile(file, 'utf8');
      if (!PGLITE_GATED_DB_IMPORT_PATTERN.test(source)) {
        continue;
      }
      for (const alias of PGLITE_GATED_DB_ALIASES) {
        if (
          source.includes(alias) &&
          !(alias === 'usePGliteDatabase' && PGLITE_ONLY_CONSUMERS.has(relativeFile))
        ) {
          matches.push(`${relativeFile}: ${alias}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
