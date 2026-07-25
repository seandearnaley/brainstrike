// Paired test for scripts/verify-no-source-cycles.mjs (BST-890).
//
// This guard closes the SECOND conjunct of the init-order invariant:
//
//     acyclic chunk graph AND acyclic source-module graph  =>  safe
//
// The chunk guard (verify-no-cross-chunk-cycles.mjs) asserts the first. It
// structurally cannot see the second: two circular SOURCE modules that land in
// the same chunk are concatenated in arbitrary order and can throw
// `Cannot access 'X' before initialization`, while the chunk graph reports no
// cycle because there is only one node.
//
// WHY THIS GUARD IS THE ONLY INSTRUMENT. Measured 2026-07-25: a genuine source
// cycle planted in apps/web/src and reachable from main.tsx BUILT SUCCESSFULLY,
// produced ZERO rolldown circular-dependency warnings, and left the chunk guard
// clean. "No circular warnings in the build log" is a blind instrument.
//
// It found a REAL cycle on its first run against this repo — three modules in
// packages/ui importing their own `@brainstrike/ui` barrel, which re-exports
// them. That is the pattern behind the BST-742 no-barrel/TDZ ruling, and it was
// fixed in the same change that added this guard.
//
// The two exclusion rules below (type-only, dynamic import) are the ones most
// likely to rot, and neither is visible from a whole-repo verdict — a guard that
// silently stopped counting an edge kind would still report "clean". They are
// therefore tested directly over fixture source text.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findCycles,
  findSourceCycles,
  main,
  resolveSourceFile,
  staticImportSpecifiers,
} from '../verify-no-source-cycles.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a graph from `{ 'a': ['b'] }` without touching the filesystem. */
function graphOf(spec) {
  return new Map(Object.entries(spec).map(([node, deps]) => [node, new Set(deps)]));
}

// --- specifier extraction ----------------------------------------------------

test('counts a normal value import', () => {
  assert.deepEqual(staticImportSpecifiers("import { Button } from './button';"), ['./button']);
});

test('counts a bare side-effect import — it DOES affect init order', () => {
  assert.deepEqual(staticImportSpecifiers("import './register-side-effects';"), [
    './register-side-effects',
  ]);
});

test('counts a re-export, which links a binding into this module', () => {
  assert.deepEqual(staticImportSpecifiers("export * from './theme-toggle';"), ['./theme-toggle']);
  assert.deepEqual(staticImportSpecifiers("export { Button } from './button';"), ['./button']);
});

test('EXCLUDES `import type` — erased, never read at runtime', () => {
  assert.deepEqual(staticImportSpecifiers("import type { Props } from './types';"), []);
});

test('EXCLUDES an import whose every specifier is type-only', () => {
  assert.deepEqual(staticImportSpecifiers("import { type A, type B } from './types';"), []);
});

test('KEEPS a mixed import that carries at least one value specifier', () => {
  assert.deepEqual(staticImportSpecifiers("import { type A, b } from './mixed';"), ['./mixed']);
});

test('EXCLUDES `export type … from` — erased', () => {
  assert.deepEqual(staticImportSpecifiers("export type { Props } from './types';"), []);
});

test('EXCLUDES dynamic import() — it creates no init-order dependency', () => {
  // The false-positive control. Counting these would flag cycles that physically
  // cannot fire, and this repo splits heavily on dynamic import to keep
  // mermaid/shiki/katex/codemirror off the startup path.
  assert.deepEqual(staticImportSpecifiers("const m = await import('./lazy');"), []);
  assert.deepEqual(staticImportSpecifiers("void (() => import('./lazy'));"), []);
});

test('parses .tsx generics without tripping on JSX ambiguity', () => {
  assert.deepEqual(
    staticImportSpecifiers("import { C } from './c';\nconst x = <T,>(v: T) => v;\n", 'f.tsx'),
    ['./c']
  );
});

// --- cycle detection ---------------------------------------------------------

test('detects a two-module cycle', () => {
  assert.deepEqual(findCycles(graphOf({ a: ['b'], b: ['a'] })), [['a', 'b']]);
});

test('detects a longer cycle', () => {
  assert.deepEqual(findCycles(graphOf({ a: ['b'], b: ['c'], c: ['a'] })), [['a', 'b', 'c']]);
});

test('detects a self-import', () => {
  assert.deepEqual(findCycles(graphOf({ a: ['a'] })), [['a']]);
});

test('an acyclic diamond is clean', () => {
  assert.deepEqual(findCycles(graphOf({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })), []);
});

test('a long chain is clean, and deep recursion does not blow the stack', () => {
  // Tarjan here is iterative on purpose: the real graph is ~800 modules and a
  // recursive implementation can exceed the call stack on a deep chain.
  const spec = {};
  for (let i = 0; i < 5000; i++) {
    spec[`m${i}`] = i === 4999 ? [] : [`m${i + 1}`];
  }
  assert.deepEqual(findCycles(graphOf(spec)), []);
});

// --- module resolution -------------------------------------------------------

test('resolves a real source file, an extensionless path, and a directory index', () => {
  const uiSrc = path.join(REPO_ROOT, 'packages/ui/src');

  assert.equal(resolveSourceFile(path.join(uiSrc, 'button.tsx')), path.join(uiSrc, 'button.tsx'));
  assert.equal(resolveSourceFile(path.join(uiSrc, 'button')), path.join(uiSrc, 'button.tsx'));
  assert.ok(resolveSourceFile(uiSrc)?.endsWith('index.ts'));
  assert.equal(resolveSourceFile(path.join(uiSrc, 'definitely-not-here')), null);
});

// --- the real verdict --------------------------------------------------------

test('VERDICT: the renderer source graph has no cycles', async () => {
  const { cycles, moduleCount } = await findSourceCycles({ root: REPO_ROOT });

  assert.deepEqual(
    cycles.map((cycle) => cycle.map((f) => path.relative(REPO_ROOT, f)).join(' -> ')),
    [],
    'A circular dependency is back in the renderer source graph. Modules in a cycle that land in ' +
      'the same chunk are concatenated in arbitrary order, so a module-scope read can see an ' +
      'uninitialized binding. Import the sibling module directly instead of the package barrel.'
  );
  assert.ok(
    moduleCount > 400,
    `Only ${moduleCount} modules reached; resolution has probably broken (was 813 when written).`
  );
});

// --- instrument controls (BST-836) ------------------------------------------

test('an unreadable tree refuses instead of reporting a clean graph', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst890-empty-'));

  await assert.rejects(
    () => findSourceCycles({ root: emptyRoot }),
    /packagesDir does not exist|Could not resolve every renderer entrypoint/,
    'An empty tree must throw. Returning zero cycles there would let this guard pass on any tree ' +
      'it failed to read.'
  );
});

test('a missing entrypoint refuses rather than silently shrinking the graph', async () => {
  await assert.rejects(
    () => findSourceCycles({ entrypoints: ['apps/web/src/does-not-exist.tsx'], root: REPO_ROOT }),
    /Could not resolve every renderer entrypoint/
  );
});

test('main() on an unverifiable root throws (BST-836 entrypoint contract)', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst890-main-'));

  await assert.rejects(() => main({ repoRoot: emptyRoot }));
});
