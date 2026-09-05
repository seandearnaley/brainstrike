import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPreloadImportGraph } from '../helpers/preload-import-graph';

describe('collectPreloadImportGraph', () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  function writeEntry(source: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'preload-import-graph-'));
    fixtures.push(dir);
    const entry = path.join(dir, 'entry.ts');
    writeFileSync(entry, source);
    return entry;
  }

  it('records require() and import() with a non-literal argument as violations', () => {
    // The bundler cannot inline these, and esbuild's node target preserves them,
    // so a sandboxed preload would resolve them at runtime — or fail to.
    const entry = writeEntry(
      [
        "const name = 'electron';",
        'const viaRequire = require(name);',
        'const viaImport = import(name);',
        'export { viaImport, viaRequire };',
        '',
      ].join('\n')
    );

    const { violations } = collectPreloadImportGraph(entry, { allowedEntryRequires: ['electron'] });

    expect(violations.map((violation) => violation.reason)).toEqual([
      expect.stringContaining('non-literal'),
      expect.stringContaining('non-literal'),
    ]);
  });

  it('still accepts the allowlisted literal require in the entry file', () => {
    const entry = writeEntry("const electron = require('electron');\nexport { electron };\n");

    expect(
      collectPreloadImportGraph(entry, { allowedEntryRequires: ['electron'] }).violations
    ).toEqual([]);
  });
});
