import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP_RENDERER_COMPONENTS_DIR = resolve(
  import.meta.dirname,
  '../../../renderer/components'
);
const PGLITE_GATED_DB_ALIASES = [
  'useBrainstrikeDatabase',
  'useBrainstrikeDbClient',
  'useOptionalBrainstrikeDatabase',
  'useOptionalBrainstrikeDbClient',
  'usePGliteDatabase',
  'useOptionalPGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;
const PGLITE_GATED_DB_IMPORT_PATTERN = new RegExp(
  `import\\s*(?:type\\s*)?\\{[^}]*\\b(?:${PGLITE_GATED_DB_ALIASES.join('|')})\\b[^}]*\\}\\s*from\\s*['"]@brainstrike/db['"]`
);
const GENERIC_DB_CLIENT_ALIASES = new Set([
  'useBrainstrikeDatabase',
  'useBrainstrikeDbClient',
  'useOptionalBrainstrikeDatabase',
  'useOptionalBrainstrikeDbClient',
]);
const PGLITE_ONLY_ALIASES = new Set([
  'usePGliteDatabase',
  'useOptionalPGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
]);
const EXISTING_GENERIC_DB_CLIENT_DEBT = new Set(['root-layout-content.tsx']);
const EXISTING_PGLITE_ONLY_DEBT = new Set(['embedding-worker-provider.tsx']);

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

describe('desktop renderer database hook imports', () => {
  it('keeps new renderer components off PGlite-gated database hooks', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(DESKTOP_RENDERER_COMPONENTS_DIR)) {
      const relativeFile = relative(DESKTOP_RENDERER_COMPONENTS_DIR, file).split(sep).join('/');
      const source = await readFile(file, 'utf8');
      if (!PGLITE_GATED_DB_IMPORT_PATTERN.test(source)) {
        continue;
      }
      for (const alias of PGLITE_GATED_DB_ALIASES) {
        if (!source.includes(alias)) {
          continue;
        }
        if (
          GENERIC_DB_CLIENT_ALIASES.has(alias) &&
          EXISTING_GENERIC_DB_CLIENT_DEBT.has(relativeFile)
        ) {
          continue;
        }
        if (PGLITE_ONLY_ALIASES.has(alias) && EXISTING_PGLITE_ONLY_DEBT.has(relativeFile)) {
          continue;
        }
        matches.push(`${relativeFile}: ${alias}`);
      }
    }

    expect(matches).toEqual([]);
  });
});
