import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';
import { collectPreloadImportGraph } from './helpers/preload-import-graph';

/**
 * BST-1648: the preload bundles (`dist/preload.js`, `dist/hidden-preload.js`)
 * run in sandboxed renderers where `require` resolves NOTHING but `electron`.
 * `scripts/build-main-config.mjs` bundles every RELATIVE import into the
 * preload output (`bundle: true`), along with configured source aliases. Other
 * bare package, `node:*`, and `electron` imports stay external `require(...)`
 * calls — so a preload may
 * import any sibling module whose transitive VALUE-import graph is pure.
 * This walk is the allowlist that replaced the old "preload imports nothing"
 * ban: type-only imports are erased by the bundler and ignored; every other
 * import is followed, and the first impure edge fails the suite by name.
 */
const PRELOAD_ENTRY_REQUIRES = ['electron'] as const;
const tempDirs: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'preload-import-graph-'));
  tempDirs.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source, 'utf8');
  }
  return root;
}

function walkFixtureEntry(root: string) {
  return collectPreloadImportGraph(path.join(root, 'entry.ts'), {
    allowedEntryRequires: PRELOAD_ENTRY_REQUIRES,
  });
}

describe('preload sandbox import graph', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects a contract module that imports electron at runtime', () => {
    const root = createFixture({
      'contract.ts': "import { clipboard } from 'electron';\nexport const c = clipboard;\n",
      'entry.ts': "const { ipcRenderer } = require('electron');\nimport './contract';\n",
    });
    const graph = walkFixtureEntry(root);
    expect(graph.violations).toEqual([
      {
        file: path.join(root, 'contract.ts'),
        reason:
          'value import of a non-relative module (only relative modules bundle into a sandboxed preload)',
        specifier: 'electron',
      },
    ]);
  });

  it.each([
    ['a node builtin', "import path from 'node:path';\nexport const p = path;\n"],
    ['a bare package', "import { x } from '@brainstrike/utils';\nexport const y = x;\n"],
    ['a CommonJS require', "const fs = require('node:fs');\nexport const f = fs;\n"],
    ['a dynamic import', "export const load = () => import('electron');\n"],
  ])('rejects %s reached transitively', (_label, contractSource) => {
    const root = createFixture({
      'contract.ts': contractSource,
      'entry.ts': "const { ipcRenderer } = require('electron');\nimport './contract';\n",
    });
    expect(walkFixtureEntry(root).violations).toHaveLength(1);
  });

  it('follows relative imports transitively and records every module it walked', () => {
    const root = createFixture({
      'b.ts': "export const B = 'b';\n",
      'entry.ts': "const { ipcRenderer } = require('electron');\nimport { A } from './nested/a';\n",
      'nested/a.ts': "import { B } from '../b';\nexport const A = B;\n",
    });
    const graph = walkFixtureEntry(root);
    expect(graph.violations).toEqual([]);
    expect(graph.modules).toEqual(
      [path.join(root, 'b.ts'), path.join(root, 'entry.ts'), path.join(root, 'nested/a.ts')].sort()
    );
  });

  it.each([
    ['pure', 'export const value = 1;', []],
    ['impure', "import fs from 'node:fs'; export const value = fs;", ['node:fs']],
  ])(
    'walks a configured bundled alias and its %s transitive exports',
    (_label, source, rejected) => {
      const root = createFixture({
        'contract/index.ts': "export { value } from './value.js';",
        'contract/value.ts': source,
        'entry.ts': "import { value } from '@fixture/contract';",
      });
      const graph = collectPreloadImportGraph(path.join(root, 'entry.ts'), {
        allowedEntryRequires: PRELOAD_ENTRY_REQUIRES,
        bundledAliases: { '@fixture/contract': path.join(root, 'contract/index.ts') },
      });
      expect(graph.modules).toEqual([
        path.join(root, 'contract/index.ts'),
        path.join(root, 'contract/value.ts'),
        path.join(root, 'entry.ts'),
      ]);
      expect(graph.violations.map(({ specifier }) => specifier)).toEqual(rejected);
    }
  );

  it('ignores type-only imports because the bundler erases them', () => {
    const root = createFixture({
      'contract.ts':
        "import type { BrowserWindow } from 'electron';\nimport { type Foo } from './types';\nexport type W = BrowserWindow;\nexport const c: Foo = 1;\n",
      'entry.ts': "const { ipcRenderer } = require('electron');\nimport './contract';\n",
      'types.ts': "import os from 'node:os';\nexport type Foo = number;\nexport const o = os;\n",
    });
    const graph = walkFixtureEntry(root);
    expect(graph.violations).toEqual([]);
    expect(graph.modules).not.toContain(path.join(root, 'types.ts'));
  });

  it('rejects an entry require outside the allowlist', () => {
    const root = createFixture({
      'entry.ts': "const { ipcRenderer } = require('electron');\nconst fs = require('node:fs');\n",
    });
    expect(walkFixtureEntry(root).violations).toEqual([
      {
        file: path.join(root, 'entry.ts'),
        reason: 'require() outside the preload entry allowlist (electron)',
        specifier: 'node:fs',
      },
    ]);
  });

  it.each(['preload.ts', 'hidden-preload.ts'])(
    'keeps the %s import graph sandbox-pure and sourced from the channel manifest',
    (entry) => {
      const sourceRoot = path.resolve(import.meta.dirname, '..');
      const graph = collectPreloadImportGraph(path.join(sourceRoot, entry), {
        allowedEntryRequires: PRELOAD_ENTRY_REQUIRES,
        bundledAliases: MAIN_PROCESS_BUILD_OPTIONS.alias,
      });
      expect(graph.violations).toEqual([]);
      expect(graph.modules).toContain(path.join(sourceRoot, 'platform', 'desktop-ipc-channels.ts'));
    }
  );
});
