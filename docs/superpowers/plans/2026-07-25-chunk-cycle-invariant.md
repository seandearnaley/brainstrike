# Chunk-Cycle Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail the build when a built renderer bundle contains a cross-chunk cycle — the necessary precondition for the module-scope init-order defect class (BST-861).

**Architecture:** One dependency-free Node script parses the emitted `.js` chunks of a bundle directory, builds a chunk→chunk graph from static import/re-export edges only, and runs Tarjan SCC over it. It is invoked from each app's own renderer `build` script, mirroring the existing `verify-tokenizer-asset-bundle.mjs` build-artifact guard, so it cannot be skipped or drift out of CI.

**Tech Stack:** Node 24 ESM (`.mjs`), `node:test` + `node:assert/strict`, no third-party dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-chunk-cycle-invariant-design.md`. Read it before starting.
- Node ESM `.mjs` only. No new dependencies — not even `glob` (this script reads one flat directory).
- The script MUST export `main` and use the `process.argv[1]` / `import.meta.url` direct-execution idiom, or `scripts/__tests__/verify-script-entrypoints.test.mjs` fails.
- `main` MUST throw (not return) on any tree it cannot verify — that test's MONEY TEST drives every `verify-*` `main` against an empty directory and fails any that reports success.
- Dynamic `import()` MUST NOT be counted as an edge. It does not participate in chunk-init ordering; counting it would invent cycles that cannot fire.
- Bare side-effect `import '…'` MUST be counted as an edge. It does participate.
- Real chunks are MINIFIED with no whitespace: `import{t as E}from"./rolldown-runtime-tSwGMm-9.js";`. Regexes must not assume spaces.
- Biome: run `pnpm exec biome check --write <files>` then `pnpm exec biome format --write <files>` before committing, or `lint:ci` fails.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Work on branch `claude/bst-861-generalize-init-order-guard` (already created off `origin/main`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/verify-no-cross-chunk-cycles.mjs` (create) | Parse chunks → graph → SCC → report. Exports `parseStaticChunkSpecifiers`, `buildChunkGraph`, `findChunkCycles`, `findCrossChunkCycles`, `main`. |
| `scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs` (create) | Detection controls, false-positive controls, floor controls, and a production-floor money test on a generated 60-chunk fixture. |
| `apps/web/package.json` (modify) | Append the guard to `build`. |
| `apps/desktop/package.json` (modify) | Append the guard to `build:renderer`. |
| `docs/agents/platform-contracts.md` (modify) | Record the invariant next to the existing chunk-init ruling. |

---

### Task 1: The guard script and its tests

**Files:**
- Create: `scripts/verify-no-cross-chunk-cycles.mjs`
- Test: `scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, relied on by Task 2 and by `verify-script-entrypoints.test.mjs`:
  - `parseStaticChunkSpecifiers(text: string): string[]` — raw specifier strings, static edges only.
  - `buildChunkGraph(chunkTexts: Map<string,string>): Map<string, Set<string>>` — keys are chunk basenames; values are basenames of sibling chunks. No floors.
  - `findChunkCycles(graph: Map<string, Set<string>>): string[][]` — each entry is one cyclic SCC, members sorted. No floors.
  - `findCrossChunkCycles(options: { directory: string, minChunks?: number, minStaticEdges?: number }): Promise<{ cycles: string[][], chunkCount: number, edgeCount: number }>` — reads the directory, applies floors, THROWS below a floor.
  - `main(options?: { directory?: string }): Promise<void>` — throws on violation or unverifiable tree.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs`:

```javascript
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
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('IGNORES dynamic import() — it does not participate in init ordering', () => {
  // The false-positive control. Counting these would block builds over cycles
  // that physically cannot fire, and dynamic splitting is used heavily here to
  // keep mermaid/shiki/katex/codemirror off the startup path.
  assert.deepEqual(parseStaticChunkSpecifiers('const m=await import("./lazy.js");'), []);
  assert.deepEqual(parseStaticChunkSpecifiers('x.then(()=>import("./lazy.js"));'), []);
});

// --- graph construction -----------------------------------------------------

test('edges point only at sibling chunks that actually exist', () => {
  const graph = graphOf({
    'a.js': 'import"./b.js";import"react";import"./not-emitted.js";',
    'b.js': 'export const b=1;',
  });

  assert.deepEqual([...(graph.get('a.js') ?? [])], ['b.js']);
});

test('a chunk importing only externals has no edges', () => {
  const graph = graphOf({ 'a.js': 'import{useState}from"react";' });

  assert.deepEqual([...(graph.get('a.js') ?? [])], []);
});

// --- detection controls: each MUST be caught --------------------------------

test('detects a two-chunk cycle', () => {
  assert.deepEqual(
    cycleNamesOf({ 'a.js': 'import"./b.js";', 'b.js': 'import"./a.js";' }),
    ['a.js,b.js']
  );
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
  assert.deepEqual(
    cycleNamesOf({ 'a.js': 'export*from"./b.js";', 'b.js': 'import"./a.js";' }),
    ['a.js,b.js']
  );
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
function writeGeneratedBundle({ withCycle }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bst861-bundle-'));
  const total = 60;

  for (let i = 0; i < total; i++) {
    const lines = [];
    if (i >= 1) {
      lines.push(i % 2 === 0 ? `import{x}from"./chunk-${i - 1}.js";` : `import"./chunk-${i - 1}.js";`);
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

test('a realistic acyclic bundle clears both floors and reports no cycles', async () => {
  const directory = writeGeneratedBundle({ withCycle: false });
  const result = await findCrossChunkCycles({ directory });

  assert.equal(result.chunkCount, 60);
  assert.equal(result.edgeCount, 117);
  assert.deepEqual(result.cycles, []);
});

test('MONEY TEST: main() rejects a real cyclic bundle at production floors', async () => {
  // The whole point. Not the pure SCC helper — the shipped entry point, on a
  // directory big enough that no floor short-circuits the verdict.
  const directory = writeGeneratedBundle({ withCycle: true });

  await assert.rejects(
    () => main({ directory }),
    /Cross-chunk cycle/,
    'main() must reject a bundle containing a genuine cross-chunk cycle.'
  );
});

// --- instrument controls (BST-836) ------------------------------------------

test('an empty directory throws rather than reporting a clean bundle', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bst861-empty-'));

  await assert.rejects(
    () => findCrossChunkCycles({ directory }),
    /below the floor/,
    'Zero discovered chunks means the directory is wrong or unbuilt. Reporting "no cycles" there ' +
      'would let this guard pass on any tree it failed to read.'
  );
});

test('a bundle whose imports no longer parse throws rather than reporting clean', async () => {
  // The regression that matters most: if a bundler output change stops the
  // import regex matching, edge count collapses to 0 and every future build
  // reports a clean bill of health forever.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bst861-noedges-'));
  for (let i = 0; i < 60; i++) {
    writeFileSync(path.join(directory, `chunk-${i}.js`), `export const x=${i};`);
  }

  await assert.rejects(() => findCrossChunkCycles({ directory }), /below the floor/);
});

test('main() with no directory argument refuses instead of guessing', async () => {
  await assert.rejects(() => main({ directory: '' }), /Usage:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
```

Expected: FAIL — `Cannot find module '../verify-no-cross-chunk-cycles.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/verify-no-cross-chunk-cycles.mjs`:

```javascript
#!/usr/bin/env node

// Guard: a built renderer bundle must contain NO cross-chunk cycles (BST-861).
//
// WHY THIS IS THE RIGHT THING TO MEASURE. A module-scope initializer that READS
// an imported binding runs at chunk initialization. ESM evaluates a module's
// dependencies before its own body, so when the chunk graph is ACYCLIC a
// topological init order always exists and every imported binding is initialized
// before any module-scope read of it. A cycle is the ONLY way to get an
// uninitialized binding at module scope. This guard therefore measures the
// NECESSARY PRECONDITION for the whole defect class rather than a proxy for it:
// zero cycles means no instance can fire, no matter how many module-scope reads
// the source contains.
//
// That completeness is why it needs no allowlist. The obvious alternative — an
// AST rule flagging module-scope reads of imported bindings — returns 431 hits in
// packages/app-shell/src + packages/db/src alone, nearly all benign
// (createLogger(), lazy(), memo(), zustand create()). The CHUNK, not the file or
// the package, is the unit of risk.
//
// FOUR RECORDED SCARS, all found by a production failure after the fact:
//   - #1292        defineContextAction TDZ; #root stays empty
//   - BST-580      browser-events; "L is not a function", blank shell
//   - (zustand)    "createWithEqualityFn is not a function", blank shell
//   - BST-558/#1988 mastra schema; "Cannot read properties of undefined
//                  (reading 'threads')" — renderer never becomes ready
// Three are still held by codeSplitting.groups pins in BOTH apps' vite configs.
//
// Nothing else in the toolchain can see this class: tsc types ESM live bindings
// identically either way, there is no lint rule for chunk-evaluation order, and
// Vitest evaluates modules in dependency order so unit tests always observe a
// defined binding. Only a production build has a chunk graph.
//
// Full rationale and the measurements behind the floors:
// docs/superpowers/specs/2026-07-25-chunk-cycle-invariant-design.md

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Anti-vacuous floors (BST-836: an instrument that cannot fail is not evidence).
 *
 * Measured at 657cd3538: web 362 chunks / 1003 edges, desktop renderer 367 /
 * 1036. These sit far below that, so ordinary bundle churn never trips them —
 * but a wrong directory, an unbuilt tree, or a bundler output change that stops
 * the import regex matching all fail loudly instead of reporting "no cycles"
 * forever.
 */
const MIN_CHUNKS = 50;
const MIN_STATIC_EDGES = 100;

/**
 * Static import edges. Anchored on a statement boundary (`;`, `}` or newline, or
 * start of file) because real chunks are MINIFIED onto single lines.
 *
 * The optional clause excludes `(`, so `import("./x.js")` cannot match: with the
 * clause skipped the pattern would need a quote immediately after `import`, and a
 * dynamic import has a paren there. Dynamic imports must NOT be edges — they do
 * not participate in init ordering.
 */
const STATIC_IMPORT_PATTERN =
  /(?:^|[;}\n])\s*import\s*(?:[^'"();]*?\s*from\s*)?["']([^"']+)["']/g;

/** `export * from '…'`, `export * as ns from '…'`, `export { a } from '…'`. */
const STATIC_REEXPORT_PATTERN =
  /(?:^|[;}\n])\s*export\s*(?:\*(?:\s*as\s*[^'"{};]+?)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;

/** Raw specifier strings for every STATIC edge in one chunk's source text. */
export function parseStaticChunkSpecifiers(text) {
  const specifiers = [];
  for (const pattern of [STATIC_IMPORT_PATTERN, STATIC_REEXPORT_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * chunk basename -> set of sibling chunk basenames it statically depends on.
 * Specifiers that do not resolve to an emitted sibling (bare packages, assets,
 * anything not in the directory) are ignored.
 */
export function buildChunkGraph(chunkTexts) {
  const names = new Set(chunkTexts.keys());
  const graph = new Map();

  for (const [name, text] of chunkTexts) {
    const dependencies = new Set();
    for (const specifier of parseStaticChunkSpecifiers(text)) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const target = path.basename(specifier);
      if (names.has(target)) {
        dependencies.add(target);
      }
    }
    graph.set(name, dependencies);
  }

  return graph;
}

/** Cyclic strongly-connected components (size > 1, or a self-edge). */
export function findChunkCycles(graph) {
  let counter = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  const visit = (node) => {
    indexes.set(node, counter);
    lowLinks.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) {
      return;
    }
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    const isSelfEdge = component.length === 1 && (graph.get(node) ?? new Set()).has(node);
    if (component.length > 1 || isSelfEdge) {
      cycles.push(component.sort());
    }
  };

  for (const node of graph.keys()) {
    if (!indexes.has(node)) {
      visit(node);
    }
  }

  return cycles;
}

/**
 * Read a built bundle directory and report its cyclic components.
 * THROWS below either floor — a tree this cannot read must never look clean.
 */
export async function findCrossChunkCycles({
  directory,
  minChunks = MIN_CHUNKS,
  minStaticEdges = MIN_STATIC_EDGES,
}) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunkNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();

  if (chunkNames.length < minChunks) {
    throw new Error(
      `Found only ${chunkNames.length} emitted chunk(s) in ${directory}, below the floor of ` +
        `${minChunks}. The directory is wrong or the bundle was never built; this guard cannot ` +
        'report a meaningful verdict on it.'
    );
  }

  const chunkTexts = new Map();
  for (const name of chunkNames) {
    chunkTexts.set(name, await readFile(path.join(directory, name), 'utf8'));
  }

  const graph = buildChunkGraph(chunkTexts);
  const edgeCount = [...graph.values()].reduce((total, set) => total + set.size, 0);

  if (edgeCount < minStaticEdges) {
    throw new Error(
      `Parsed only ${edgeCount} static cross-chunk edge(s) across ${chunkNames.length} chunks in ` +
        `${directory}, below the floor of ${minStaticEdges}. The bundler's output format has ` +
        'probably changed and the import patterns no longer match — without this check the guard ' +
        'would report every future build as clean.'
    );
  }

  return { chunkCount: chunkNames.length, cycles: findChunkCycles(graph), edgeCount };
}

/**
 * Like verify-tokenizer-asset-bundle.mjs, this inspects a BUILD ARTIFACT rather
 * than the repo tree, so it takes a bundle directory. `directory` is threaded as
 * an option so the BST-836 entrypoint contract test can drive it against a tree
 * where it must not pass.
 *
 * @param {{ directory?: string }} options
 */
export async function main(options = {}) {
  const directoryArgument = options.directory ?? process.argv[2];
  if (!directoryArgument) {
    throw new Error('Usage: verify-no-cross-chunk-cycles.mjs <bundle-directory>');
  }

  const directory = path.resolve(process.cwd(), directoryArgument);
  const { chunkCount, cycles, edgeCount } = await findCrossChunkCycles({ directory });

  if (cycles.length > 0) {
    const rendered = cycles
      .map((cycle) => `  CYCLE (${cycle.length} chunks):\n${cycle.map((n) => `    - ${n}`).join('\n')}`)
      .join('\n\n');

    throw new Error(
      'Cross-chunk cycle in the built renderer bundle. Chunk init order is not guaranteed inside ' +
        'a cycle, so a module-scope read of an imported binding can see `undefined`: a property ' +
        'access throws and kills the renderer at startup, and a bare interpolation silently ' +
        `splices "undefined" into strings.\n\n${rendered}\n\n` +
        'Fix, in order of preference:\n' +
        '  1. Move the module-scope read inside the function that uses it (durable — no chunk ' +
        'order can break it).\n' +
        "  2. Co-locate the modules in one chunk via codeSplitting.groups in the app's " +
        'vite.config.mts (config-level; a later refactor can silently undo it).\n' +
        'See docs/agents/platform-contracts.md, "read them only inside a function".'
    );
  }

  process.stdout.write(
    `No cross-chunk cycles: ${chunkCount} chunks, ${edgeCount} static edges (${directory})\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
```

Expected: PASS — all tests, `fail 0`.

- [ ] **Step 5: Verify against the REAL bundles**

```bash
pnpm build:web && node scripts/verify-no-cross-chunk-cycles.mjs apps/web/dist/assets
```

Expected: `No cross-chunk cycles: 362 chunks, 1003 static edges (…)`. Chunk/edge counts will drift; the point is a clean verdict with counts far above the floors. If it reports a cycle, STOP — that is a real finding, not a guard bug; report it before continuing.

- [ ] **Step 6: Verify the entrypoint contract still passes**

```bash
node --test scripts/__tests__/verify-script-entrypoints.test.mjs
```

Expected: PASS. This test auto-discovers `verify-*.mjs` and drives every `main` against an empty directory; the new script must throw there (it will — zero chunks is below the floor).

- [ ] **Step 7: Format and commit**

```bash
pnpm exec biome check --write scripts/verify-no-cross-chunk-cycles.mjs scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
pnpm exec biome format --write scripts/verify-no-cross-chunk-cycles.mjs scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
git add scripts/verify-no-cross-chunk-cycles.mjs scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
git commit -m "$(cat <<'MSG'
feat(scripts): assert the built renderer bundle has no cross-chunk cycles (BST-861)

A cross-chunk cycle is the NECESSARY PRECONDITION for the module-scope
init-order class, not a proxy for it: ESM evaluates dependencies before a
module's body, so an acyclic chunk graph guarantees every imported binding is
initialized before any module-scope read. Asserting acyclicity is therefore
complete for the class and needs no allowlist — unlike an AST rule, which
returns 431 hits in app-shell + db alone, nearly all benign.

Dynamic import() is deliberately not an edge; it does not participate in init
ordering, and counting it would block builds over cycles that cannot fire.

Floors throw rather than reporting clean: below 50 chunks the directory is wrong
or unbuilt, and below 100 static edges the import patterns have stopped matching
the bundler's output (measured today: web 362/1003, desktop 367/1036).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: Wire the guard into both renderer builds and record the ruling

**Files:**
- Modify: `apps/web/package.json` (the `build` script)
- Modify: `apps/desktop/package.json` (the `build:renderer` script)
- Modify: `docs/agents/platform-contracts.md`

**Interfaces:**
- Consumes: `scripts/verify-no-cross-chunk-cycles.mjs` from Task 1, invoked as `node ../../scripts/verify-no-cross-chunk-cycles.mjs <dir>`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs`:

```javascript
// --- wiring ------------------------------------------------------------------
//
// Wired into each app's own build rather than a CI step, mirroring
// verify-tokenizer-asset-bundle.mjs (run inside chunking-worker and token-cache
// builds). That makes it unskippable: it runs in the Build job, in both E2E jobs
// (which build first), and locally, with no CI-only wiring that can drift.

test('both renderer builds run the guard on their emitted bundle', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (relative) =>
    JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')).scripts;

  assert.match(
    read('apps/web/package.json').build,
    /node \.\.\/\.\.\/scripts\/verify-no-cross-chunk-cycles\.mjs dist\/assets/,
    'apps/web must verify its bundle as part of `build`.'
  );
  assert.match(
    read('apps/desktop/package.json')['build:renderer'],
    /node \.\.\/\.\.\/scripts\/verify-no-cross-chunk-cycles\.mjs dist\/renderer\/assets/,
    'apps/desktop must verify its renderer bundle as part of `build:renderer`.'
  );
});
```

Add these imports to the top of the same file (merge with the existing `node:fs` import):

```javascript
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
```

Expected: FAIL — `apps/web must verify its bundle as part of \`build\``.

- [ ] **Step 3: Wire both build scripts**

In `apps/web/package.json`, change:

```json
"build": "vite build",
```

to:

```json
"build": "vite build && node ../../scripts/verify-no-cross-chunk-cycles.mjs dist/assets",
```

In `apps/desktop/package.json`, change:

```json
"build:renderer": "vite build",
```

to:

```json
"build:renderer": "vite build && node ../../scripts/verify-no-cross-chunk-cycles.mjs dist/renderer/assets",
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
```

Expected: PASS, `fail 0`.

- [ ] **Step 5: Prove the wiring actually runs in a real build**

```bash
pnpm build:web 2>&1 | grep -F "No cross-chunk cycles"
```

Expected: one line reporting the chunk and edge counts. If nothing prints, the guard is wired but not executing — investigate before continuing (a turbo cache hit will also skip it; force with `--force` if needed).

- [ ] **Step 6: Record the ruling in the contract doc**

In `docs/agents/platform-contracts.md`, find the paragraph beginning `Nothing else catches this class:` and insert this immediately after the paragraph that ends `...or `await import()`, or the same import added from any other module.`:

```markdown
**The structural backstop is an acyclic chunk graph (BST-861).** A cross-chunk
cycle is the NECESSARY PRECONDITION for this whole class, not a proxy for it:
ESM evaluates a module's dependencies before its own body, so with an acyclic
chunk graph a topological init order always exists and every imported binding is
initialized before any module-scope read of it. `scripts/verify-no-cross-chunk-cycles.mjs`
asserts that on the emitted bundle and runs inside `apps/web`'s `build` and
`apps/desktop`'s `build:renderer`, so it cannot be skipped. Measured at the time
it landed: web 362 chunks / 1003 static edges / 0 cycles, desktop renderer 367 /
1036 / 0.

This is why the mastra-family AST guard above is NOT generalized: the cycle
invariant already covers every constant family, including the three still held
by `codeSplitting.groups` pins in both vite configs (context-actions #1292,
browser-events BST-580, zustand). The AST guard is kept because it does
something the cycle check cannot — enforce the coding rule at review time, in
seconds, with a file and line number. A repo-wide AST rule was rejected on
measurement: "flag every module-scope read of an imported binding" returns 431
hits in `app-shell` + `db` alone, nearly all benign. The CHUNK, not the file or
the package, is the unit of risk.
```

- [ ] **Step 7: Run the full gate**

```bash
pnpm build && pnpm run lint:ci && pnpm type-check && pnpm test && pnpm test:scripts
```

Expected: all five green in the same run. `test:scripts` should report a higher total than before (the new file adds ~19 tests).

- [ ] **Step 8: Format and commit**

```bash
pnpm exec biome check --write scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
pnpm exec biome format --write scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
git add apps/web/package.json apps/desktop/package.json docs/agents/platform-contracts.md scripts/__tests__/verify-no-cross-chunk-cycles.test.mjs
git commit -m "$(cat <<'MSG'
build: run the chunk-cycle guard inside both renderer builds (BST-861)

Wired into each app's own build script rather than a CI step, mirroring
verify-tokenizer-asset-bundle.mjs. It therefore runs in the Build job, in both
E2E jobs (which build first), and locally, with no CI-only wiring that can drift
out of sync.

Records the ruling in platform-contracts.md, including why the mastra-family AST
guard is deliberately NOT generalized: the cycle invariant already covers every
family, and a repo-wide AST rule was rejected on measurement (431 benign hits in
app-shell + db alone).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Self-Review

**Spec coverage.** Invariant → Task 1 Step 3. Static-only parsing with `import()` excluded → Task 1 Steps 1/3 plus two dedicated false-positive controls. Wiring into both renderer builds → Task 2 Step 3, pinned by the test in Step 1. Floors → Task 1 Step 3, with two control tests. Entrypoint contract → Task 1 Step 6. Failure message → Task 1 Step 3, asserted by the money test. All eight test categories from the spec appear in Task 1 Step 1. Out-of-scope items (AST guard untouched, pins untouched, Electron main uncovered) → recorded in Task 2 Step 6; no task modifies them. Verification plan items 1–3 → Task 1 Steps 4–5 and Task 2 Step 7; item 4 (E2E) is covered by CI after the PR opens.

**Placeholder scan.** No TBD/TODO; every code step carries complete code; no "similar to Task N".

**Type consistency.** `parseStaticChunkSpecifiers`, `buildChunkGraph`, `findChunkCycles`, `findCrossChunkCycles`, `main` are spelled identically in the interfaces block, the implementation, and the test imports. `findCrossChunkCycles` returns `{ chunkCount, cycles, edgeCount }` and both consumers destructure exactly those three names.

**One gap found and fixed inline:** the test file needs `readFileSync` and `fileURLToPath`, which Task 1's import block omits because only Task 2 uses them. Task 2 Step 1 now states the merged import lines explicitly rather than leaving the engineer to infer them.
