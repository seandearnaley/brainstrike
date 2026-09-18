// Paired test for scripts/verify-no-cross-chunk-cycles.mjs (BST-861).
//
// This guard asserts the NECESSARY PRECONDITION for the CROSS-CHUNK form of
// the module-scope init-order class: ESM evaluates a module's dependencies
// before its own body, so with an acyclic CHUNK graph every chunk's imported
// bindings are initialized before any module-scope read of them — no chunk
// can observe another chunk's export before that chunk has finished
// initializing. That is complete for the cross-chunk shape behind all four
// scars below, which is why it needs no allowlist there.
//
// It is not complete for the whole class: two SOURCE modules that are
// themselves circular and land in the same chunk are concatenated in
// arbitrary order, so one can still read the other's binding before it is
// initialized, while the chunk graph reports no cycle at all (a single
// node has no cross-chunk edge to flag). That intra-chunk source-cycle form
// is a separate, still-undetected gap tracked in BST-890.
//
// Four recorded scars motivate it: #1292 (defineContextAction TDZ, blank #root),
// BST-580 (browser-events, "L is not a function"), the zustand pin
// ("createWithEqualityFn is not a function"), and BST-558/#1988 (mastra schema,
// "Cannot read properties of undefined (reading 'threads')"). Every one was found
// by a production failure after the fact.
//
// The controls below are load-bearing, not decoration. An instrument that cannot
// go red is not evidence (BST-836), and the two failure directions here are very
// different: a false NEGATIVE lets the class back in silently, while a false
// POSITIVE (counting a dynamic import as an edge) would block builds over a cycle
// that physically cannot fire.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildChunkGraph,
  findChunkCycles,
  findCrossChunkCycles,
  main,
  parseStaticChunkSpecifiers,
} from '../verify-no-cross-chunk-cycles.mjs';

/** Build a graph from `{ 'a.js': 'source…' }` without touching the filesystem. */
function graphOf(files) {
  return buildChunkGraph(new Map(Object.entries(files)));
}

function cycleNamesOf(files) {
  return findChunkCycles(graphOf(files))
    .map((cycle) => cycle.join(','))
    .sort();
}

/** Register cleanup for a mkdtempSync'd directory so temp dirs don't accumulate. */
function cleanUpTempDir(t, directory) {
  t.after(() => rmSync(directory, { force: true, recursive: true }));
}

// --- specifier parsing: real bundles are MINIFIED, no whitespace ------------

test('parses the minified import form rolldown actually emits', () => {
  assert.deepEqual(parseStaticChunkSpecifiers('import{t as E}from"./rt-tSwGMm.js";var L=1;'), [
    './rt-tSwGMm.js',
  ]);
});

test('parses bare side-effect imports, which DO affect init order', () => {
  assert.deepEqual(parseStaticChunkSpecifiers('import"./side.js";'), ['./side.js']);
});

test('parses minified re-export forms', () => {
  assert.deepEqual(parseStaticChunkSpecifiers('export*from"./a.js";'), ['./a.js']);
  assert.deepEqual(parseStaticChunkSpecifiers('export{x as y}from"./b.js";'), ['./b.js']);
});

test('parses several statements sharing one minified line', () => {
  assert.deepEqual(
    parseStaticChunkSpecifiers('import{a}from"./a.js";import{b}from"./b.js";const c=1;'),
    ['./a.js', './b.js']
  );
});

test('parses an import preceded by a preserved legal comment banner', () => {
  // Terser and rolldown preserve `/*! … */` banners. One sitting between two
  // top-level imports must not break the statement-boundary anchor — a
  // dropped edge here could hide a genuine cycle.
  assert.deepEqual(parseStaticChunkSpecifiers('import"./a.js";/*! lic */import"./b.js";'), [
    './a.js',
    './b.js',
  ]);
});

test('parses a re-export preceded by a preserved legal comment banner', () => {
  assert.deepEqual(parseStaticChunkSpecifiers('import"./a.js";/*! lic */export*from"./b.js";'), [
    './a.js',
    './b.js',
  ]);
});

test('parses an import preceded by a JSDoc-style @license legal comment', () => {
  // Terser's default `comments: 'some'` preserves ANY block comment matching
  // `/^\**!|@preserve|@license|@cc_on/`, not just the `/*!` banner form.
  // apps/web/vite.config.mts sets `minify: 'terser'`, so a `/** @license … */`
  // banner is a real, reachable shape — not just the `/*!` one.
  assert.deepEqual(
    parseStaticChunkSpecifiers('import"./a.js";/** @license MIT */import"./b.js";'),
    ['./a.js', './b.js']
  );
});

test('parses an import preceded by a preserved @preserve legal comment', () => {
  assert.deepEqual(parseStaticChunkSpecifiers('import"./a.js";/* @preserve */import"./b.js";'), [
    './a.js',
    './b.js',
  ]);
});

test('parses an import preceded by a preserved @cc_on legal comment', () => {
  assert.deepEqual(parseStaticChunkSpecifiers('import"./a.js";/* @cc_on */import"./b.js";'), [
    './a.js',
    './b.js',
  ]);
});

test('parses a re-export preceded by a JSDoc-style @license legal comment', () => {
  assert.deepEqual(
    parseStaticChunkSpecifiers('import"./a.js";/** @license MIT */export*from"./b.js";'),
    ['./a.js', './b.js']
  );
});

test('does NOT skip a plain, non-preserved comment (known limitation, BST-890)', () => {
  // `/* just a note */` matches none of Terser's preserved-comment markers,
  // so Terser strips it in a real build and it never actually sits between
  // two top-level imports. This guard intentionally does not treat it as a
  // skippable comment — doing so would mean skipping ANY `/* … */`, which
  // reintroduces the string-content false negative covered below. Accepted
  // gap, tracked in BST-890: the second edge is dropped here.
  assert.deepEqual(parseStaticChunkSpecifiers('import"./a.js";/* just a note */import"./b.js";'), [
    './a.js',
  ]);
});

test('a string containing `;/*` does not swallow subsequent edges as a fake comment', () => {
  // A regex cannot distinguish a comment from string content — only a real
  // parser can. Requiring the banner's actual `!` marker (`/*!`, not any
  // `/* … */` shape) is what rejects this string at the boundary: without
  // it, `;/*` inside a string gets treated as the start of a comment and the
  // lazy body keeps expanding until it finds the next `*/` anywhere later in
  // the chunk — however far away and however unrelated — swallowing every
  // real import in between and dropping their edges. The 2000-char cap is a
  // second, independent guard against a pathological match spanning
  // arbitrarily far even when a `!` genuinely opens the comment. A dropped
  // edge can hide a genuine cross-chunk cycle, which is exactly what this
  // guard exists to catch.
  assert.deepEqual(
    parseStaticChunkSpecifiers('x=";/*";import"./a.js";y="*/import";import"./b.js";'),
    ['./a.js', './b.js']
  );
});

test('IGNORES dynamic import() — it does not participate in init ordering', () => {
  // The false-positive control. Counting these would block builds over cycles
  // that physically cannot fire, and dynamic splitting is used heavily here to
  // keep mermaid/shiki/katex/codemirror off the startup path.
  assert.deepEqual(parseStaticChunkSpecifiers('const m=await import("./lazy.js");'), []);
  assert.deepEqual(parseStaticChunkSpecifiers('x.then(()=>import("./lazy.js"));'), []);
});

test('IGNORES dynamic import() even when it sits at a statement boundary', () => {
  // Both cases above are rejected by the statement-boundary anchor alone —
  // `import` there is never preceded by `;`/`}`/newline/start-of-file. This
  // case puts a dynamic import right after a `;` instead, so the anchor no
  // longer rejects it.
  //
  // It still comes back empty, but NOT because of the `(` exclusion: the `(`
  // is immediately followed by a `"`, which the optional clause's character
  // class always excludes (real dynamic-import arguments are always a bare
  // string literal), so the clause can never reach a `from` token regardless
  // of whether `(` itself is excluded. Confirmed by ablation — this assertion
  // still passes with `(` removed from STATIC_IMPORT_PATTERN's class.
  assert.deepEqual(parseStaticChunkSpecifiers('const a=1;import("./x.js").then(f);'), []);
});

test('the `(` exclusion is what stops a dynamic import containing a literal "from"', () => {
  // The genuine ablation case for the `(` exclusion: an adversarial
  // dynamic-import-shaped string whose parenthesized argument contains the
  // literal substring "from" immediately before the specifier's quote, with
  // no excluded character (quote/`)`/`;`) in between. This is not valid JS —
  // real dynamic-import arguments never look like this — but the pattern is
  // plain text matching, not a parser, so it must stay defensive against any
  // input shaped this way.
  //
  // Ablation-verified: with `(` removed from STATIC_IMPORT_PATTERN's
  // character class, this incorrectly returns ['./x.js'] instead of [].
  assert.deepEqual(parseStaticChunkSpecifiers('const a=1;import(x from"./x.js");'), []);
});

// --- graph construction -----------------------------------------------------

test('edges point only at sibling chunks that actually exist', () => {
  const graph = graphOf({
    'a.js': 'import"./b.js";import"react";import"./not-emitted.js";',
    'b.js': 'export const b=1;',
  });

  // Assert the key exists before asserting its contents, so an implementation
  // that never sets 'a.js' at all cannot pass this by falling through to `??`.
  assert.ok(graph.has('a.js'));
  assert.deepEqual([...graph.get('a.js')], ['b.js']);
});

test('a chunk importing only externals has no edges', () => {
  const graph = graphOf({ 'a.js': 'import{useState}from"react";' });

  assert.ok(graph.has('a.js'));
  assert.deepEqual([...graph.get('a.js')], []);
});

// --- detection controls: each MUST be caught --------------------------------

test('detects a two-chunk cycle', () => {
  assert.deepEqual(cycleNamesOf({ 'a.js': 'import"./b.js";', 'b.js': 'import"./a.js";' }), [
    'a.js,b.js',
  ]);
});

test('detects a three-chunk cycle', () => {
  assert.deepEqual(
    cycleNamesOf({
      'a.js': 'import"./b.js";',
      'b.js': 'import"./c.js";',
      'c.js': 'import"./a.js";',
    }),
    ['a.js,b.js,c.js']
  );
});

test('detects a self-import', () => {
  assert.deepEqual(cycleNamesOf({ 'a.js': 'import"./a.js";' }), ['a.js']);
});

test('detects a cycle closed by a re-export rather than an import', () => {
  assert.deepEqual(cycleNamesOf({ 'a.js': 'export*from"./b.js";', 'b.js': 'import"./a.js";' }), [
    'a.js,b.js',
  ]);
});

// --- false-positive controls: each MUST be clean ----------------------------

test('an acyclic diamond is clean', () => {
  assert.deepEqual(
    cycleNamesOf({
      'a.js': 'import"./b.js";import"./c.js";',
      'b.js': 'import"./d.js";',
      'c.js': 'import"./d.js";',
      'd.js': 'export const d=1;',
    }),
    []
  );
});

test('a dynamic-import "cycle" is clean', () => {
  // a and b reference each other, but only dynamically. Real bundles do this
  // constantly; flagging it would make the guard unusable.
  assert.deepEqual(
    cycleNamesOf({
      'a.js': 'const b=()=>import("./b.js");',
      'b.js': 'const a=()=>import("./a.js");',
    }),
    []
  );
});

test('a long acyclic chain is clean', () => {
  const files = {};
  for (let i = 0; i < 20; i++) {
    files[`c${i}.js`] = i === 0 ? 'export const v=0;' : `import"./c${i - 1}.js";`;
  }

  assert.deepEqual(cycleNamesOf(files), []);
});

// --- realistic fixture at PRODUCTION floors ---------------------------------

/**
 * Write a bundle big enough to clear the real floors (60 chunks, 117 edges), so
 * `main` can be driven with its PRODUCTION thresholds. Lowering the floors for
 * the test would leave the shipped values unexercised.
 */
function writeGeneratedBundle(t, { withCycle }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bst861-bundle-'));
  cleanUpTempDir(t, directory);
  const total = 60;

  for (let i = 0; i < total; i++) {
    const lines = [];
    if (i >= 1) {
      lines.push(
        i % 2 === 0 ? `import{x}from"./chunk-${i - 1}.js";` : `import"./chunk-${i - 1}.js";`
      );
    }
    if (i >= 2) {
      lines.push(`import"./chunk-${i - 2}.js";`);
    }
    if (i === 0 && withCycle) {
      lines.push(`import"./chunk-${total - 1}.js";`);
    }
    lines.push(`export const x=${i};`);
    writeFileSync(path.join(directory, `chunk-${i}.js`), lines.join(''));
  }

  return directory;
}

test('a realistic acyclic bundle clears both floors and reports no cycles', async (t) => {
  const directory = writeGeneratedBundle(t, { withCycle: false });
  const result = await findCrossChunkCycles({ directory });

  assert.equal(result.chunkCount, 60);
  assert.equal(result.edgeCount, 117);
  assert.deepEqual(result.cycles, []);
});

test('MONEY TEST: main() rejects a real cyclic bundle at production floors', async (t) => {
  // The whole point. Not the pure SCC helper — the shipped entry point, on a
  // directory big enough that no floor short-circuits the verdict.
  const directory = writeGeneratedBundle(t, { withCycle: true });

  await assert.rejects(
    () => main({ directory }),
    /Cross-chunk cycle/,
    'main() must reject a bundle containing a genuine cross-chunk cycle.'
  );
});

// --- instrument controls (BST-836) ------------------------------------------

test('an empty directory throws rather than reporting a clean bundle', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bst861-empty-'));
  cleanUpTempDir(t, directory);

  await assert.rejects(
    () => findCrossChunkCycles({ directory }),
    /below the floor/,
    'Zero discovered chunks means the directory is wrong or unbuilt. Reporting "no cycles" there ' +
      'would let this guard pass on any tree it failed to read.'
  );
});

test('a bundle whose imports no longer parse throws rather than reporting clean', async (t) => {
  // The regression that matters most: if a bundler output change stops the
  // import regex matching, edge count collapses to 0 and every future build
  // reports a clean bill of health forever.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bst861-noedges-'));
  cleanUpTempDir(t, directory);
  for (let i = 0; i < 60; i++) {
    writeFileSync(path.join(directory, `chunk-${i}.js`), `export const x=${i};`);
  }

  await assert.rejects(() => findCrossChunkCycles({ directory }), /below the floor/);
});

test('main() with no directory argument refuses instead of guessing', async () => {
  await assert.rejects(() => main({ directory: '' }), /Usage:/);
});

// --- wiring ------------------------------------------------------------------
//
// Wired into each app's own build rather than a CI step, mirroring
// verify-tokenizer-asset-bundle.mjs (run inside chunking-worker and token-cache
// builds). That makes it unskippable: it runs in the Build job, in both E2E jobs
// (which build first), and locally, with no CI-only wiring that can drift.
//
// A substring match alone only proves the guard is INVOKED somewhere in the
// script, not ENFORCED: `vite build; node …verify-no-cross-chunk-cycles.mjs
// dist/assets || true` would still contain the invocation while swallowing its
// exit code, and the build would never fail. Each regex below therefore pins
// two things at once — the invocation is joined with `&&` (never `;`/`||`,
// which would let a failing prior step or a neutralised guard exit code slip
// through), and it sits at the literal END of the script (`$`), so no trailing
// `|| true` (or any other suffix) can neutralise it after the fact.

const WEB_BUILD_GUARD_RE =
  /&&\s*node \.\.\/\.\.\/scripts\/verify-no-cross-chunk-cycles\.mjs dist\/assets$/;
const DESKTOP_RENDERER_GUARD_RE =
  /&&\s*node \.\.\/\.\.\/scripts\/verify-no-cross-chunk-cycles\.mjs dist\/renderer\/assets$/;
// The renderer guard above is orphaned if `build` never reaches
// `build:renderer` in the first place — check that edge too, and require the
// same `&&` join so a broken-out `build:renderer` cannot be neutralised either.
const DESKTOP_BUILD_INVOKES_RENDERER_RE = /(?:^|&&)\s*pnpm build:renderer(?:\s|&&|$)/;

test('both renderer builds run the guard on their emitted bundle, enforced not just invoked', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (relative) =>
    JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')).scripts;

  assert.match(
    read('apps/web/package.json').build,
    WEB_BUILD_GUARD_RE,
    'apps/web must run the guard `&&`-joined at the END of `build`, so its exit code cannot be swallowed by a trailing `|| true` or a `;` join.'
  );
  assert.match(
    read('apps/desktop/package.json')['build:renderer'],
    DESKTOP_RENDERER_GUARD_RE,
    'apps/desktop must run the guard `&&`-joined at the END of `build:renderer`, so its exit code cannot be swallowed by a trailing `|| true` or a `;` join.'
  );
  assert.match(
    read('apps/desktop/package.json').build,
    DESKTOP_BUILD_INVOKES_RENDERER_RE,
    "apps/desktop's `build` must actually invoke `build:renderer` — otherwise the renderer guard above is wired but never reached."
  );
});

test('app build tasks list the guard so editing it invalidates their build cache', () => {
  // A cached build never re-invokes the guard (or `build` at all) — see
  // docs/agents/platform-contracts.md. Without task-local input entries,
  // editing the guard would leave a stale cache HIT reporting a build that
  // never actually ran the new guard logic.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const app of ['web', 'desktop']) {
    const turboConfig = readFileSync(path.join(repoRoot, `apps/${app}/turbo.json`), 'utf8');
    assert.ok(turboConfig.includes('$TURBO_ROOT$/scripts/verify-no-cross-chunk-cycles.mjs'));
  }
  // ci-guard-input-locality.test.mjs runs the pinned Turbo binary to prove
  // the actual task hashes AND affected selection, including negative controls.
});
