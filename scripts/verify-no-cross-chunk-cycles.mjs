#!/usr/bin/env node

// Guard: a built renderer bundle must contain NO cross-chunk cycles (BST-861).
//
// WHY THIS IS THE RIGHT THING TO MEASURE. A module-scope initializer that READS
// an imported binding runs at chunk initialization. ESM evaluates a module's
// dependencies before its own body, so when the chunk graph is ACYCLIC a
// topological init order always exists BETWEEN CHUNKS, which removes the
// CROSS-CHUNK form of the hazard: no chunk can observe another chunk's export
// before that chunk has finished initializing.
//
// That is not the whole class. Two source modules that are themselves
// circular and happen to land in the SAME chunk are still a hazard: rolldown
// concatenates them in an arbitrary order, so one can read the other's
// binding before it is initialized, and the emitted chunk graph reports no
// cycle at all because there is only one node. This guard cannot see that
// case — it is a separate, still-undetected form of the same defect, not
// covered by "acyclic chunk graph" alone. The accurate claim is: acyclic
// chunk graph AND acyclic source-module graph together are what guarantee
// every imported binding is initialized before any module-scope read of it.
// Only the first conjunct is enforced here.
//
// Completeness for the cross-chunk form is why it needs no allowlist there. The
// obvious alternative — an AST rule flagging module-scope reads of imported
// bindings — returns 431 hits in packages/app-shell/src + packages/db/src
// alone, nearly all benign (createLogger(), lazy(), memo(), zustand create()).
// The CHUNK, not the file or the package, is the unit of risk for that form.
//
// FIVE RECORDED SCARS, all found by a production failure after the fact:
//   - #1292        defineContextAction TDZ; #root stays empty
//   - BST-580      browser-events; "L is not a function", blank shell
//   - (zustand)    "createWithEqualityFn is not a function", blank shell
//   - BST-558/#1988 mastra schema; "Cannot read properties of undefined
//                  (reading 'threads')" — renderer never becomes ready
//   - BST-858      sanitized persist merge; "a is not a function", blank shell
// Four are still held by codeSplitting.groups pins in BOTH apps' vite configs.
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
 * Dynamic `import()` must never match — dynamic imports do not participate in
 * init ordering, so counting one as an edge would be a false positive. The
 * optional clause's character class excludes both quotes and `(`. The quote
 * exclusion is what stops the ordinary `import("./x.js")` form: the clause
 * can never advance past the opening quote to reach a `from` token, so it
 * fails to match and the pattern falls back to requiring a quote immediately
 * after `import`, which the `(` isn't. The `(` exclusion is what stops the
 * adversarial `import(x from"./x.js")` form, where an unquoted identifier
 * would otherwise let the clause walk past the paren to a literal `from`.
 *
 * An optional block comment may sit between the boundary character and the
 * keyword: the minifier (apps/web uses Vite's default, oxc) and rolldown preserve
 * "legal comment" banners, and one of those between two top-level imports
 * would otherwise break the anchor and silently drop the second edge.
 * Terser's default `comments: 'some'` preserves any block comment whose body
 * matches `/^\**!|@preserve|@license|@cc_on/` — not just a `!`-prefixed
 * banner, but also a JSDoc-style opener carrying `@license`, `@preserve`, or
 * `@cc_on` anywhere in its body. The clause below requires one of those
 * literal markers rather than accepting any block-comment opener — a regex
 * cannot distinguish a comment from string content, so accepting any opener
 * lets a chunk containing a string with a bare `/` immediately followed by
 * `*` get misread as a comment start, with the lazy body swallowing
 * everything up to a later, unrelated comment terminator and dropping the
 * real edges in between. Requiring an actual preserved-comment marker rejects
 * that string at the boundary instead of trying to out-distance it. The
 * marker search itself is barred from crossing the comment's own closing
 * delimiter (via a per-character negative lookahead) so it can only ever
 * match within THIS comment's own body, never by continuing past its close
 * into unrelated later source looking for a marker that has nothing to do
 * with this comment. The body is also bounded to 2000 chars, far more than
 * any real banner needs, as a second, independent guard against a
 * pathological match spanning arbitrarily far. A plain, non-preserved
 * comment (one with none of those markers) is deliberately NOT skipped —
 * that is a known, accepted limitation tracked in BST-890, not a bug: the
 * minifier strips it, so it never actually appears between two imports in a real
 * build.
 */
const STATIC_IMPORT_PATTERN =
  /(?:^|[;}\n])\s*(?:\/\*(?=\*{0,}!|(?:(?!\*\/)[\s\S]){0,2000}?(?:@license|@preserve|@cc_on))[\s\S]{0,2000}?\*\/\s*)?import\s*(?:[^'"();]*?\s*from\s*)?["']([^"']+)["']/g;

/** `export * from '…'`, `export * as ns from '…'`, `export { a } from '…'`. */
const STATIC_REEXPORT_PATTERN =
  /(?:^|[;}\n])\s*(?:\/\*(?=\*{0,}!|(?:(?!\*\/)[\s\S]){0,2000}?(?:@license|@preserve|@cc_on))[\s\S]{0,2000}?\*\/\s*)?export\s*(?:\*(?:\s*as\s*[^'"{};]+?)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;

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
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
    )
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
      .map(
        (cycle) => `  CYCLE (${cycle.length} chunks):\n${cycle.map((n) => `    - ${n}`).join('\n')}`
      )
      .join('\n\n');

    throw new Error(
      'Cross-chunk cycle in the built renderer bundle. Chunk init order is not guaranteed inside ' +
        'a cycle, so a module-scope read of an imported binding can see `undefined`: a property ' +
        'access throws and kills the renderer at startup, and a bare interpolation silently ' +
        `splices "undefined" into strings.\n\n${rendered}\n\n` +
        'Fix:\n' +
        '  1. Move the module-scope read inside the function that uses it. This is always ' +
        'correct — no chunk order can break it, regardless of what the underlying source ' +
        'modules do.\n' +
        "  2. Co-locate the modules in one chunk via codeSplitting.groups in the app's " +
        'vite.config.mts. WARNING: this only helps if the underlying SOURCE modules are not ' +
        'themselves in a cycle. If they are, co-location hides the cycle from THIS guard ' +
        '(one chunk has no cross-chunk edge to flag) without fixing it — concatenation order ' +
        'inside a chunk is arbitrary, so the same uninitialized-binding crash can still fire, ' +
        'just undetected. Use option 2 only after confirming the source modules are acyclic; ' +
        'when in doubt, use option 1.\n' +
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
