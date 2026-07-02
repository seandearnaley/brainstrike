import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const DB_EXPLORER_SRC_DIR = resolve(import.meta.dirname, '..');
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
const BRAINSTRIKE_DB_NAMED_IMPORT_PATTERN =
  /import\s*(?:type\s*)?\{(?<imports>[^}]*)\}\s*from\s*['"]@brainstrike\/db['"]/g;
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
const EXISTING_GENERIC_DB_CLIENT_DEBT = new Set([
  'database-demo-panel.tsx',
  'hooks/use-search-functionality.ts',
  'hooks/use-semantic-search-executor.ts',
]);

function findImportedGatedDbAliases(source: string): string[] {
  const aliases: string[] = [];
  for (const match of source.matchAll(BRAINSTRIKE_DB_NAMED_IMPORT_PATTERN)) {
    const imports = match.groups?.['imports'] ?? '';
    for (const specifier of imports.split(',')) {
      const [rawImportedName = ''] = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      const importedName = rawImportedName.trim();
      if (PGLITE_GATED_DB_ALIASES.some((alias) => alias === importedName)) {
        aliases.push(importedName);
      }
    }
  }
  return aliases;
}

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

describe('db explorer database hook imports', () => {
  it('keeps new production consumers off PGlite-gated database hooks', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(DB_EXPLORER_SRC_DIR)) {
      const relativeFile = relative(DB_EXPLORER_SRC_DIR, file).split(sep).join('/');
      const source = await readFile(file, 'utf8');
      for (const alias of findImportedGatedDbAliases(source)) {
        if (
          GENERIC_DB_CLIENT_ALIASES.has(alias) &&
          EXISTING_GENERIC_DB_CLIENT_DEBT.has(relativeFile)
        ) {
          continue;
        }
        if (PGLITE_ONLY_ALIASES.has(alias)) {
          matches.push(`${relativeFile}: ${alias}`);
          continue;
        }
        matches.push(`${relativeFile}: ${alias}`);
      }
    }

    expect(matches).toEqual([]);
  });
});
