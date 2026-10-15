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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveThroughAliases } from '../../packages/test-utils/workspace-src-aliases.mjs';
import {
  classifySpecifier,
  deferredImportSpecifiers,
  findCycles,
  findSourceCycles,
  main,
  RENDERER_APPS,
  rendererAliasEntries,
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

test('EXCLUDES a re-export whose every specifier is type-only', () => {
  // Symmetry with the import branch. Review caught this asymmetry: the marker
  // sits on each element rather than the statement, so an erased re-export was
  // counted as a runtime edge — a false positive that would block the lint lane
  // on a cycle that cannot fire.
  assert.deepEqual(staticImportSpecifiers("export { type A, type B } from './types';"), []);
});

test('KEEPS a re-export carrying at least one value specifier', () => {
  assert.deepEqual(staticImportSpecifiers("export { type A, b } from './mixed';"), ['./mixed']);
});

test('EXCLUDES dynamic import() from EDGES — it creates no init-order dependency', () => {
  // The false-positive control. Counting these as edges would flag cycles that
  // physically cannot fire, and this repo splits heavily on dynamic import to
  // keep mermaid/shiki/katex/codemirror off the startup path.
  assert.deepEqual(staticImportSpecifiers("const m = await import('./lazy');"), []);
  assert.deepEqual(staticImportSpecifiers("void (() => import('./lazy'));"), []);
});

test('EXCLUDES a Vite `?worker&url` import from EDGES — it loads a separate bundle', () => {
  assert.deepEqual(staticImportSpecifiers("import u from './embedding.worker.ts?worker&url';"), []);
});

// --- deferred specifiers: not edges, but traversal ROOTS --------------------

test('collects dynamic import() as a traversal root', () => {
  // Without this the entire subgraph behind a lazy boundary was never analyzed —
  // a silent coverage hole, not a wrong answer. Controlled end-to-end by the
  // planted lazy-only cycle described in the guard header.
  const lazy = [{ kind: 'import', specifier: './lazy' }];
  assert.deepEqual(deferredImportSpecifiers("const m = await import('./lazy');"), lazy);
  assert.deepEqual(deferredImportSpecifiers("void (() => import('./lazy'));"), lazy);
});

test('collects Vite query-suffixed imports as traversal roots', () => {
  // Kind `import`: Vite fails the build when the file is missing, so these
  // must resolve like any import — only `new URL(...)` may name a non-module.
  assert.deepEqual(deferredImportSpecifiers("import u from './x.worker.ts?worker&url';"), [
    { kind: 'import', specifier: './x.worker.ts?worker&url' },
  ]);
});

test('a plain static import is NOT a deferred root — it is an edge', () => {
  assert.deepEqual(deferredImportSpecifiers("import { a } from './a';"), []);
});

test('collects `new Worker(new URL(...))` targets as roots', () => {
  // packages/db/src/wasm-loader.ts spawns both PGlite workers this way. Before
  // this, neither worker graph was walked at all, so a cycle inside a
  // separately bundled worker would fire at runtime while lint reported clean.
  assert.deepEqual(
    deferredImportSpecifiers(
      "const w = new Worker(new URL('./pglite-worker-entry.ts', import.meta.url), { type: 'module' });"
    ),
    [{ kind: 'url', specifier: './pglite-worker-entry.ts' }]
  );
});

test('collects a `new URL(...)` bound to a variable, not just inline in `new Worker`', () => {
  // Matched on `new URL` rather than `new Worker` so SharedWorker and the
  // `const url = new URL(…)` indirection are covered by the same rule.
  assert.deepEqual(
    deferredImportSpecifiers(
      "const url = new URL('./bootstrap-worker-entry.ts', import.meta.url);"
    ),
    [{ kind: 'url', specifier: './bootstrap-worker-entry.ts' }]
  );
});

test('the real wasm-loader has BOTH PGlite worker entries collected', () => {
  // Pins the concrete case the review named, so a refactor of that file cannot
  // quietly drop the workers back out of the graph.
  const wasmLoader = readFileSync(path.join(REPO_ROOT, 'packages/db/src/wasm-loader.ts'), 'utf8');
  const roots = deferredImportSpecifiers(wasmLoader, 'wasm-loader.ts');
  const hasUrlRoot = (specifier) =>
    roots.some((root) => root.kind === 'url' && root.specifier === specifier);

  assert.ok(hasUrlRoot('./pglite-worker-entry.ts'), 'PGlite worker entry must be a root.');
  assert.ok(
    hasUrlRoot('./browser-first-run-bootstrap-worker-entry.ts'),
    'First-run bootstrap worker entry must be a root.'
  );
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

test('resolves an ESM `.js` specifier to the `.ts` file it names', () => {
  // NodeNext specifiers name the EMITTED file, so TypeScript source is imported
  // as `./thing.js`. packages/assistant-contract and packages/utils do this
  // throughout; before this rewrite every such edge vanished from the graph
  // while the guard still reported "clean". That is the dropped-edge failure
  // this whole guard exists to prevent, so it is pinned here.
  const contractSrc = path.join(REPO_ROOT, 'packages/assistant-contract/src');

  assert.equal(
    resolveSourceFile(path.join(contractSrc, 'tool-metadata.js')),
    path.join(contractSrc, 'tool-metadata.ts')
  );
});

// --- scope: a workspace specifier is never third-party ----------------------

const WEB_APP = RENDERER_APPS.find((app) => app.name === 'web');

/**
 * Walk a one-file fixture app beside the real web app. The web graph clears the
 * module floor, so any refusal comes from the fixture, never from the floor.
 */
function findSourceCyclesWithFixture(fileName, sourceText) {
  const fixtureEntry = path.join(mkdtempSync(path.join(os.tmpdir(), 'bst890-fixture-')), fileName);
  writeFileSync(fixtureEntry, sourceText);
  return findSourceCycles({
    apps: [
      WEB_APP,
      { entrypoint: path.relative(REPO_ROOT, fixtureEntry), name: 'fixture', overrides: [] },
    ],
    root: REPO_ROOT,
  });
}

test('an unmapped @brainstrike/* specifier is UNRESOLVED, not out of scope', () => {
  // The scope hole. `@brainstrike/hooks` exports only its root, so no alias
  // claims this subpath; the guard used to classify it as a third-party package
  // and drop the edge, so a cycle through it was reported clean.
  const aliases = rendererAliasEntries(REPO_ROOT, []);
  const fromFile = path.join(REPO_ROOT, 'apps/web/src/main.tsx');

  assert.deepEqual(
    classifySpecifier({ aliases, fromFile, specifier: '@brainstrike/hooks/use-app-active' }),
    { unresolved: true }
  );
  // The two legitimate out-of-scope classes are unchanged.
  assert.deepEqual(classifySpecifier({ aliases, fromFile, specifier: 'react' }), {
    outOfScope: true,
  });
  assert.deepEqual(
    classifySpecifier({ aliases, fromFile, specifier: '@brainstrike/ui/styles.css' }),
    { outOfScope: true }
  );
});

test('the planted-cycle repro: an unmapped @brainstrike/* edge refuses instead of reporting clean', async () => {
  // The reproduction that found the hole: a cross-package cycle planted
  // through `@brainstrike/hooks/use-app-active` reported "No source cycles"
  // and exit 0. Its closing edge lives in package source this test may not
  // edit, and the guard by definition cannot see where an unmapped specifier
  // lands — so the contract pinned here is the one that matters: the walk
  // REFUSES and names the edge.
  await assert.rejects(
    () =>
      findSourceCyclesWithFixture(
        'planted.ts',
        "import { useAppActive } from '@brainstrike/hooks/use-app-active';\nexport const planted = useAppActive;\n"
      ),
    /@brainstrike\/hooks\/use-app-active {2}\(in [^)]*planted\.ts\)/
  );
});

test('a source-pointing workspace export resolves the way Vite resolves it', () => {
  // After an alias miss, Vite resolves `@brainstrike/*` through the package's
  // own `exports`. `@brainstrike/embedding-worker/vite` targets `./src/vite.ts`,
  // so that file IS what both renderers load; the registry gives it no alias
  // because it needs none.
  const aliases = rendererAliasEntries(REPO_ROOT, []);

  assert.deepEqual(
    classifySpecifier({
      aliases,
      fromFile: path.join(REPO_ROOT, 'apps/web/src/create-embedding-queue.ts'),
      specifier: '@brainstrike/embedding-worker/vite',
    }),
    { file: path.join(REPO_ROOT, 'packages/embedding-worker/src/vite.ts') }
  );
});

test('a dist-pointing workspace export stays UNRESOLVED unless an app decides it', () => {
  // A dist target means the build would bundle COMPILED output, which a source
  // guard cannot analyse. That must stay loud, so each case gets an explicit
  // decision: fix the app's resolution, or a documented RENDERER_APPS override.
  const fromFile = path.join(
    REPO_ROOT,
    'apps/web/src/embedding-model-switch-memory-probe.worker.ts'
  );
  const specifier = '@brainstrike/embedding-worker/worker';

  // Checked on the alias list itself, so it holds whether or not `dist` has
  // been built: an exports-derived alias to dist would resolve once it exists.
  assert.equal(resolveThroughAliases(specifier, rendererAliasEntries(REPO_ROOT, [])), null);
  assert.deepEqual(
    classifySpecifier({ aliases: rendererAliasEntries(REPO_ROOT, []), fromFile, specifier }),
    { unresolved: true }
  );
  assert.deepEqual(
    classifySpecifier({
      aliases: rendererAliasEntries(REPO_ROOT, WEB_APP.overrides),
      fromFile,
      specifier,
    }),
    { file: path.join(REPO_ROOT, 'packages/embedding-worker/src/embedding.worker.ts') }
  );
});

// --- deferred roots: only `new URL(...)` may name a non-module ---------------

test('a missing dynamic import() or ?worker target is reported, not exempted as an asset', async () => {
  // A dropped ROOT loses everything behind that lazy boundary. These used to
  // share the `new URL` asset exemption, so a dynamic import of a file that is
  // not there was silently out of scope and its whole subgraph unanalyzed.
  await assert.rejects(
    () =>
      findSourceCyclesWithFixture(
        'lazy.ts',
        "import u from './missing.worker.ts?worker&url';\nexport const lazy = () => import('./missing-lazy');\nexport { u };\n"
      ),
    (error) => {
      assert.match(error.message, /\.\/missing-lazy {2}\(in [^)]*lazy\.ts\)/);
      assert.match(error.message, /\.\/missing\.worker\.ts\?worker&url {2}\(in [^)]*lazy\.ts\)/);
      return true;
    }
  );
});

test('an unresolvable `new URL(...)` asset stays out of scope', async () => {
  // The control. `new URL('./x', import.meta.url)` legitimately names non-module
  // assets (.wasm, images, fonts), some of which only exist after a build, so
  // the exemption must survive for exactly this form.
  const { cycles } = await findSourceCyclesWithFixture(
    'asset.ts',
    "export const wasm = new URL('./emitted-at-build-time.wasm', import.meta.url);\n"
  );

  assert.deepEqual(cycles, []);
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
    moduleCount > 1000,
    `Only ${moduleCount} modules reached; resolution has probably broken (was 1261 when written).`
  );
});

test('the app overrides mirror what each vite config declares before the registry', () => {
  // The guard resolves per app because the two renderers do NOT resolve
  // @brainstrike/* identically — apps/web pins @brainstrike/file-explorer to
  // dist, desktop does not. Review caught that a single shared alias set
  // analysed a DIFFERENT module than the one that ships (file-tree-worker's
  // Node entry instead of its browser-adapted src/vite.ts). This pins the
  // mirror: an override added to a vite config and forgotten here fails.
  const overridesFor = (configPath) => readFileSync(path.join(REPO_ROOT, configPath), 'utf8');

  for (const [configPath, expected] of [
    ['apps/web/vite.config.mts', ['file-tree-worker/src/vite.ts', 'workers']],
    ['apps/desktop/vite.config.mts', ['file-tree-worker/src/vite.ts', 'workers']],
  ]) {
    const source = overridesFor(configPath);
    for (const fragment of expected) {
      assert.ok(
        source.includes(fragment),
        `${configPath} no longer declares an alias containing "${fragment}", but ` +
          'RENDERER_APPS in verify-no-source-cycles.mjs still mirrors it. The guard would analyse ' +
          'a different module than the app builds.'
      );
    }
  }

  // The one deliberate divergence, pinned so it stays deliberate. apps/web pins
  // @brainstrike/file-explorer to dist for a RUNTIME worker-artifact reason;
  // this guard must NOT mirror it, because dist is compiled output (wrong input
  // for a source-cycle guard) and only exists after a build — mirroring it made
  // the guard pass locally and fail in CI's Static job, which does not build.
  assert.ok(
    readFileSync(path.join(REPO_ROOT, 'apps/web/vite.config.mts'), 'utf8').includes(
      'file-explorer/dist'
    ),
    'apps/web no longer pins @brainstrike/file-explorer to dist. The guard deliberately does not ' +
      'mirror that pin; if the pin is gone, delete this assertion and the explanation beside ' +
      'RENDERER_APPS so the divergence is not documented as live when it no longer is.'
  );

  // The second deliberate divergence. The web BUILD resolves
  // @brainstrike/embedding-worker/worker through `exports` to the prebuilt dist
  // bundle; the guard analyses the source that bundle is built from, which is
  // the pin the web Vitest lane already declares. Both halves are pinned so the
  // explanation beside RENDERER_APPS cannot outlive either fact.
  const webVitest = readFileSync(path.join(REPO_ROOT, 'apps/web/vitest.config.mts'), 'utf8');
  assert.ok(
    webVitest.includes("find: '@brainstrike/embedding-worker/worker'") &&
      webVitest.includes('packages/embedding-worker/src/embedding.worker.ts'),
    'apps/web/vitest.config.mts no longer pins @brainstrike/embedding-worker/worker to source. ' +
      "RENDERER_APPS' web override cites that pin; revisit it."
  );
  assert.ok(
    !overridesFor('apps/web/vite.config.mts').includes('@brainstrike/embedding-worker/worker'),
    'apps/web/vite.config.mts now aliases @brainstrike/embedding-worker/worker itself, so the web ' +
      'override mirrors the build instead of diverging from it; update the explanation beside ' +
      'RENDERER_APPS.'
  );
});

// --- instrument controls (BST-836) ------------------------------------------

test('an unreadable tree refuses instead of reporting a clean graph', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst890-empty-'));

  await assert.rejects(
    () => findSourceCycles({ root: emptyRoot }),
    /Could not resolve the \w+ renderer entrypoint|packagesDir does not exist/,
    'An empty tree must throw. Returning zero cycles there would let this guard pass on any tree ' +
      'it failed to read.'
  );
});

test('a missing entrypoint refuses rather than silently shrinking the graph', async () => {
  await assert.rejects(
    () =>
      findSourceCycles({
        apps: [{ entrypoint: 'apps/web/src/does-not-exist.tsx', name: 'bogus', overrides: [] }],
        root: REPO_ROOT,
      }),
    /Could not resolve the bogus renderer entrypoint/
  );
});

test('main() on an unverifiable root throws (BST-836 entrypoint contract)', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst890-main-'));

  await assert.rejects(() => main({ repoRoot: emptyRoot }));
});
