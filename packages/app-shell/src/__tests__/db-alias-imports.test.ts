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
  'useOptionalPGliteDatabase',
  'usePGliteLiveQuery',
  'UsePGliteLiveQueryOptions',
] as const;
const BRAINSTRIKE_DB_NAMED_IMPORT_PATTERN =
  /import\s*(?:type\s*)?\{(?<imports>[^}]*)\}\s*from\s*['"]@brainstrike\/db['"]/g;

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

describe('app shell database hook imports', () => {
  it('keeps new production consumers off PGlite-gated database hooks', async () => {
    const matches: string[] = [];
    for (const file of await listSourceFiles(APP_SHELL_SRC_DIR)) {
      const relativeFile = relative(APP_SHELL_SRC_DIR, file).split(sep).join('/');
      const source = await readFile(file, 'utf8');
      for (const alias of findImportedGatedDbAliases(source)) {
        matches.push(`${relativeFile}: ${alias}`);
      }
    }

    expect(matches).toEqual([]);
  });
});
