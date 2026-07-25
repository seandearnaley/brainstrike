// Paired test for scripts/verify-no-cross-chunk-cycles.mjs (BST-861).
//
// This guard asserts the NECESSARY PRECONDITION for the module-scope
// init-order class: a cross-chunk cycle. ESM evaluates a module's dependencies
// before its own body, so with an acyclic chunk graph every imported binding is
// initialized before any module-scope read of it. A cycle is the only way to get
// an uninitialized binding at module scope — which is why this is complete for
// the class rather than a heuristic, and why it needs no allowlist.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

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
