#!/usr/bin/env node

// Guard: the renderer's SOURCE module graph must be acyclic (BST-890).
//
// THE SECOND CONJUNCT. `scripts/verify-no-cross-chunk-cycles.mjs` asserts the
// built bundle's CHUNK graph is acyclic. That is necessary but NOT sufficient.
// The full invariant is:
//
//     acyclic chunk graph AND acyclic source-module graph  =>  safe
//
// Two source modules that are themselves circular and land in the SAME chunk are
// concatenated by rolldown in an arbitrary order, so one can read the other's
// binding before it is initialized — `ReferenceError: Cannot access 'A' before
// initialization`. The chunk graph reports no cycle at all, because there is only
// one node. This guard closes that half.
//
// MEASURED, not assumed (2026-07-25): a genuine source cycle planted in
// apps/web/src and reachable from main.tsx BUILT SUCCESSFULLY, produced ZERO
// rolldown circular-dependency warnings, and the chunk guard reported clean. The
// bundler will not tell you. "No circular warnings in the build log" is a blind
// instrument, not evidence.
//
// WHY RESOLUTION GOES THROUGH THE ALIAS REGISTRY, NOT tsconfig. Resolving
// `@brainstrike/*` the TypeScript way reaches `packages/*/dist/*.d.ts`, so
// cross-package SOURCE — where every recorded scar of this class lives — is
// invisible. `packages/test-utils/workspace-src-aliases.mjs` is the repo's single
// source of truth for `@brainstrike/* -> src` and exists for the same stale-dist
// incident class (#1066/#1207).
//
// EVERY DROPPED EDGE IS A POTENTIAL HIDDEN CYCLE, so coverage was grown until
// nothing in scope fails to resolve. The reachable-module count tells that
// story, and each step was a real defect in this guard, not a tuning knob:
//   139  tsconfig resolution — cross-package source invisible
//   768  + the workspace src-alias registry
//   813  + curated agent browser-safe subpaths and @brainstrike/workers
//  1261  + per-app vite overrides, dynamic/worker imports as ROOTS, and the ESM
//         `.js`-names-a-`.ts`-file rewrite
//  2283  (from 2263) + a `@brainstrike/*` specifier no alias claims is a dropped
//         edge, never third-party; source-pointing package `exports`; curated
//         agent `mcp-tasks`. The scope hole was hiding the production embedding
//         worker's whole source graph and desktop's MCP Tasks closure.
// `EXPECTED_UNRESOLVED` is consequently EMPTY: every in-scope specifier resolves.
//
// EDGES vs ROOTS — the distinction the cycle definition rests on:
//   - `import type` / type-only specifiers are erased; not edges, not roots.
//   - a bare side-effect `import '…'` DOES affect init order; an EDGE.
//   - dynamic `import()` and Vite `?worker`/`?url` imports create no init-order
//     dependency, so they are NOT edges — counting them would flag cycles that
//     physically cannot fire. But their targets are real modules with their own
//     static graphs, so they ARE traversal roots. Treating them as neither left
//     everything behind a lazy boundary unanalyzed.
//
// Full rationale: docs/superpowers/specs/2026-07-25-chunk-cycle-invariant-design.md

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createAgentBrowserSafeAliasEntries } from '../packages/agent/config/browser-safe-subpath-aliases.mjs';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '../packages/test-utils/workspace-src-aliases.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseRepoRootArgument(argv) {
  if (argv.length === 0) {
    return;
  }
  const [argument, value] = argv;
  if (argv.length !== 2 || argument !== '--repo-root' || !value || value.startsWith('--')) {
    throw new Error('verify-no-source-cycles: expected only --repo-root <path>');
  }
  return path.resolve(value);
}

/**
 * One graph PER APP, not a merged one: the two renderers do not resolve
 * `@brainstrike/*` identically, so a single shared alias set would faithfully
 * represent neither. `apps/web` pins `@brainstrike/file-explorer` to `dist` (its
 * worker artifact must be prebuilt) while desktop takes the registry's source;
 * a merged graph would silently analyze the wrong module for one of them.
 *
 * `overrides` mirrors the entries each app places BEFORE the registry spread in
 * its own `vite.config.mts`. `scripts/__tests__/verify-no-source-cycles.test.mjs`
 * asserts parity with those configs, so an override added there and forgotten
 * here fails loudly instead of quietly changing which modules are analyzed.
 *
 * TWO DELIBERATE DIVERGENCES, both where the web build consumes `dist`:
 *
 * 1. `apps/web` pins `@brainstrike/file-explorer` to `dist`, and this guard does
 *    NOT mirror that. Two reasons, both decisive. First, `dist` is COMPILED
 *    OUTPUT — analyzing it would make a *source*-cycle guard report on generated
 *    JavaScript. Second, it only exists after a build, so mirroring it made the
 *    guard pass locally (where dist was present) and fail in CI's Static job,
 *    which does not build. The web pin exists so the emitted worker artifact is
 *    available to a module Worker at RUNTIME; that is not a module-structure
 *    concern. Desktop already analyzes this package's source, so using source
 *    for both is the consistent and correct choice.
 * 2. `@brainstrike/embedding-worker/worker` resolves through the package's
 *    `exports` to the prebuilt `dist/embedding.worker.js` (the registry skips
 *    `*.worker` bundles on purpose), imported only by the web E2E memory probe.
 *    The guard analyzes `src/embedding.worker.ts`, the source that bundle is
 *    built from, for the same two reasons. It is the pin
 *    `apps/web/vitest.config.mts` already declares, and the module production
 *    reaches anyway through `@brainstrike/embedding-worker/vite`'s
 *    `?worker&url` import.
 */
export const RENDERER_APPS = Object.freeze([
  {
    entrypoint: 'apps/web/src/main.tsx',
    name: 'web',
    overrides: [
      ['@brainstrike/file-tree-worker', 'packages/file-tree-worker/src/vite.ts'],
      ['@brainstrike/workers', 'packages/workers'],
      // Divergence 2 above: the source of the prebuilt bundle the build loads.
      ['@brainstrike/embedding-worker/worker', 'packages/embedding-worker/src/embedding.worker.ts'],
      // App-local aliases. Unused by any import today, but modelled anyway: an
      // unmodelled alias makes its imports look third-party, and third-party is
      // silently out of scope — so a future `@/foo` would vanish from the graph
      // with nothing to catch it.
      ['@web', 'apps/web/src'],
      ['@', 'apps/web/src'],
      ['src', 'apps/web/src'],
    ],
  },
  {
    entrypoint: 'apps/desktop/src/renderer/main.tsx',
    name: 'desktop',
    overrides: [
      ['@brainstrike/file-tree-worker', 'packages/file-tree-worker/src/vite.ts'],
      ['@brainstrike/workers', 'packages/workers'],
      ['@', 'apps/desktop/src'],
    ],
  },
]);

/**
 * Anti-vacuous floor (BST-836: an instrument that cannot fail is not evidence).
 * Measured at 1261 modules for the larger of the two renderer graphs. If a
 * resolution change or a bad entry path collapses the graph, that must fail
 * loudly rather than report "no cycles" forever. Keep the headroom modest: an
 * earlier 400 against ~813 was loose enough that losing half the graph would
 * still have passed.
 */
const MIN_MODULES = 1000;

/**
 * In-scope specifiers excused from resolving.
 *
 * DELIBERATELY EMPTY. Stylesheets, non-module assets and third-party packages
 * are classified out of scope by `classifySpecifier` rather than excused here
 * (and a `@brainstrike/*` specifier is never third-party), so every remaining
 * specifier — relative, workspace, or app-aliased — currently resolves to a
 * real source file. Adding an entry means accepting a dropped edge, and a
 * dropped edge can hide a cycle; do it only with a written reason.
 *
 * This is what caught the ESM `.js`-extension class: `packages/assistant-contract`
 * and `packages/utils` import TypeScript source as `./thing.js`, and before
 * `resolveSourceFile` learned that rewrite, dozens of edges were vanishing
 * silently while the guard still reported "clean".
 */
const EXPECTED_UNRESOLVED = Object.freeze([]);

/** Vite's asset/worker query suffixes: `./x.ts?worker&url`, `./y.svg?raw`. */
const VITE_QUERY_SUFFIX = /\?.*$/;

/** Every package in this monorepo, and nothing third-party, lives under this scope. */
const WORKSPACE_SCOPE = '@brainstrike/';

/** A stylesheet import is not a module edge, whatever shape the specifier takes. */
function isStyleSheetSpecifier(specifier) {
  return /\.(?:css|scss|sass|less)(?:\?.*)?$/.test(specifier);
}

/**
 * Resolution mirrors what each renderer build actually does, composed from the
 * repo's own helpers rather than reinvented, in the same first-match order the
 * apps use:
 *
 * 1. the app's own config-local overrides (see `RENDERER_APPS`), which exist
 *    precisely because the registry would derive the WRONG target — e.g.
 *    `@brainstrike/file-tree-worker`'s root export is a Node worker_threads
 *    entry, while `src/vite.ts` is the browser-adapted implementation the
 *    renderer actually loads;
 * 2. `createAgentBrowserSafeAliasEntries` — `@brainstrike/agent` is deliberately
 *    excluded from the shared registry (root and most subpaths pull Node-only
 *    Mastra deps), so only the curated browser-safe subpaths resolve;
 * 3. `workspaceSrcAliases` — every other `@brainstrike/*` package to SOURCE;
 * 4. `workspaceSourceExportEntries` — what Vite does after every alias misses.
 */
export function rendererAliasEntries(root, overrides) {
  return [
    ...overrides.map(([find, replacement]) => ({
      find,
      replacement: path.join(root, replacement),
    })),
    ...createAgentBrowserSafeAliasEntries(path.join(root, 'packages/agent')),
    ...workspaceSrcAliases(path.join(root, 'packages')),
    ...workspaceSourceExportEntries(path.join(root, 'packages')),
  ];
}

/**
 * Vite's NEXT step when no alias matches: the package's own `exports` map. The
 * registry aliases only `dist`-backed exports, because a source-pointing one
 * (`"./vite": "./src/vite.ts"`) already lands in source without an alias. That
 * is right for Vite and invisible to a guard that resolves through aliases
 * alone, so these entries model the exports step for exactly that case.
 *
 * ONLY source targets. A `dist` target is compiled output the renderer would
 * bundle as-is, so it stays UNRESOLVED on purpose: each one needs a decision —
 * fix the app's resolution, or a documented `RENDERER_APPS` override. The
 * renderer imports ESM, so the `import` (else `default`) condition names the
 * file; any other shape is skipped and therefore also reported, never guessed.
 */
function workspaceSourceExportEntries(packagesDir) {
  const entries = [];
  for (const dirName of readdirSync(packagesDir)) {
    const manifestPath = path.join(packagesDir, dirName, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const { exports: exportsMap, name } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!name?.startsWith(WORKSPACE_SCOPE) || typeof exportsMap !== 'object') {
      continue;
    }
    for (const [key, value] of Object.entries(exportsMap)) {
      const target = typeof value === 'string' ? value : (value?.import ?? value?.default);
      if (key.includes('*') || typeof target !== 'string' || !target.startsWith('./src/')) {
        continue;
      }
      const specifier = key === '.' ? name : `${name}/${key.slice('./'.length)}`;
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      entries.push({
        find: new RegExp(`^${escaped}$`),
        replacement: path.join(packagesDir, dirName, target),
      });
    }
  }
  return entries;
}

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/**
 * ESM-style specifiers name the EMITTED file, so TypeScript source under
 * NodeNext is imported as `./thing.js` while the file on disk is `./thing.ts`.
 * Large parts of this repo do that — `packages/assistant-contract` and
 * `packages/utils` throughout. Without this rewrite every such edge silently
 * vanished from the graph, which is exactly the dropped-edge failure this guard
 * exists to prevent.
 */
const EMITTED_TO_SOURCE_EXTENSIONS = Object.freeze({
  '.cjs': ['.cts'],
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
});

/** Probe a path as a file, then with each extension, then as a directory index. */
export function resolveSourceFile(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  const emittedExtension = path.extname(candidate);
  for (const sourceExtension of EMITTED_TO_SOURCE_EXTENSIONS[emittedExtension] ?? []) {
    const sourceFile = candidate.slice(0, -emittedExtension.length) + sourceExtension;
    if (existsSync(sourceFile)) {
      return sourceFile;
    }
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    if (existsSync(candidate + extension)) {
      return candidate + extension;
    }
  }
  for (const extension of RESOLVABLE_EXTENSIONS) {
    const indexFile = path.join(candidate, `index${extension}`);
    if (existsSync(indexFile)) {
      return indexFile;
    }
  }
  return null;
}

/**
 * Specifiers whose binding is read at module-evaluation time.
 *
 * Exported so the paired test can drive it over fixture SOURCE TEXT — the
 * type-only and dynamic-import exclusions are the two rules most likely to rot,
 * and both are invisible from a whole-repo verdict.
 */
export function staticImportSpecifiers(sourceText, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause) {
        const isTypeOnly =
          clause.phaseModifier === undefined
            ? clause.isTypeOnly === true
            : clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
        if (isTypeOnly) {
          continue;
        }
        const named = clause.namedBindings;
        const everySpecifierIsTypeOnly =
          !clause.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly);
        if (everySpecifierIsTypeOnly) {
          continue;
        }
      }
      if (
        ts.isStringLiteral(statement.moduleSpecifier) &&
        // `./x.ts?worker&url` loads a SEPARATE bundle; it is a traversal root
        // (see deferredImportSpecifiers), never an init-order edge here.
        !VITE_QUERY_SUFFIX.test(statement.moduleSpecifier.text)
      ) {
        specifiers.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      !statement.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      // Symmetric with the import branch above: `export type { A } from` is
      // caught by `isTypeOnly`, but `export { type A, type B } from` puts the
      // marker on each element instead, and is equally erased. Missing this
      // counted an erased re-export as a runtime edge — a false positive that
      // would block the lint lane on a cycle that cannot fire.
      const named = statement.exportClause;
      const everySpecifierIsTypeOnly =
        named &&
        ts.isNamedExports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly);
      if (!everySpecifierIsTypeOnly) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }

  return specifiers;
}

/**
 * Specifiers whose module is loaded, but NOT as part of this module's
 * initialization: dynamic `import()` and Vite's `?worker` / `?url` / `?raw`
 * asset forms.
 *
 * These are not EDGES — they create no init-order dependency, and counting them
 * would flag cycles that physically cannot fire. But their targets are still
 * real modules with their own static graphs, so they are traversal ROOTS.
 * Without this, everything reachable only behind a lazy boundary (the whole
 * `@brainstrike/app-shell/git-panel` subtree, every worker entry) was never
 * analyzed at all — a large silent coverage hole rather than a wrong answer.
 *
 * Each root carries its `kind`, because only one form may name a non-module:
 *   `import`  dynamic `import()` and query-suffixed imports. Vite fails the
 *             build when the file is missing, so these must resolve.
 *   `url`     `new URL('./x', import.meta.url)`, which legitimately names
 *             assets (.wasm, images, fonts), some only emitted by a build.
 */
export function deferredImportSpecifiers(sourceText, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ kind: 'import', specifier: node.arguments[0].text });
    }
    // `new URL('./entry.ts', import.meta.url)` — the standard Worker/asset
    // idiom, and the form `packages/db/src/wasm-loader.ts` uses for both PGlite
    // workers. Without this the whole worker graph is unwalked, so a cycle
    // inside a separately bundled worker fires at runtime while lint reports
    // clean (Magnify review, P1). Matched on `new URL` rather than on
    // `new Worker` so the same rule covers SharedWorker and the
    // `const url = new URL(…)` indirection both apps also use.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ kind: 'url', specifier: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      VITE_QUERY_SUFFIX.test(statement.moduleSpecifier.text)
    ) {
      specifiers.push({ kind: 'import', specifier: statement.moduleSpecifier.text });
    }
  }

  return specifiers;
}

/** Iterative Tarjan — the graph is ~800 nodes deep enough to blow a recursive one. */
export function findCycles(graph) {
  let counter = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  for (const root of graph.keys()) {
    if (indexes.has(root)) {
      continue;
    }
    const work = [[root, 0]];
    while (work.length > 0) {
      const frame = work.at(-1);
      const [node, childIndex] = frame;
      if (childIndex === 0) {
        indexes.set(node, counter);
        lowLinks.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const dependencies = [...(graph.get(node) ?? [])];
      if (childIndex < dependencies.length) {
        frame[1]++;
        const next = dependencies[childIndex];
        if (indexes.has(next)) {
          if (onStack.has(next)) {
            lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
          }
        } else {
          work.push([next, 0]);
        }
        continue;
      }
      if (lowLinks.get(node) === indexes.get(node)) {
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
      }
      work.pop();
      if (work.length > 0) {
        const parent = work.at(-1)[0];
        lowLinks.set(parent, Math.min(lowLinks.get(parent), lowLinks.get(node)));
      }
    }
  }

  return cycles;
}

/**
 * Walk the renderer source graph from the entrypoints and report its cycles.
 * THROWS below the module floor, or when an unexpected `@brainstrike/*`
 * specifier fails to resolve — either means the graph this reports on is not the
 * graph that ships.
 */
/**
 * Resolve one specifier to a source file, or `null`.
 *
 * `null` means one of three things, and the caller must distinguish them:
 * a stylesheet (not a module), a bare third-party package (out of scope), or a
 * genuine resolution FAILURE — which is a dropped edge that could hide a cycle.
 */
/**
 * Classify one specifier. Three outcomes, and keeping them in ONE function is
 * the point: an earlier version split "can it resolve" from "is it in scope"
 * across two predicates that had to agree about aliases, and they drifted —
 * `apps/web` really does define a bare `src` alias, but the scope predicate
 * classified `src/foo` as third-party, so an import through it would have
 * vanished from the graph with nothing to catch it (Magnify review, P2).
 *
 *   { file }        resolved to a source module — a real node
 *   { outOfScope }  legitimately not a module here: a stylesheet, a non-source
 *                   asset named by `new URL`, or a third-party package (no
 *                   alias matched, not relative, not `@brainstrike/*`)
 *   { unresolved }  an IN-SCOPE specifier that failed to resolve — a dropped
 *                   edge, which can hide a cycle. Always reported, never
 *                   tolerated. Includes every `@brainstrike/*` specifier no
 *                   alias claims: a workspace package is never third-party.
 */
export function classifySpecifier({ aliases, fromFile, isAssetReference = false, specifier }) {
  // Stylesheets are not modules in the init-order sense, and a relative one
  // WOULD otherwise resolve — `resolveSourceFile` returns any existing file —
  // padding the graph with non-modules. `apps/web/src/main.tsx` imports
  // `./app/globals.css` at the entry, so this is live, not theoretical, and the
  // padding lands in exactly the count MIN_MODULES is supposed to guard.
  if (isStyleSheetSpecifier(specifier)) {
    return { outOfScope: true };
  }

  const bare = specifier.replace(VITE_QUERY_SUFFIX, '');
  const isRelative = bare.startsWith('.');
  const aliased = isRelative ? null : resolveThroughAliases(bare, aliases);

  if (!(isRelative || aliased)) {
    // No alias matched. A `@brainstrike/*` specifier is never third-party in
    // this monorepo, so a miss is a DROPPED EDGE, not something out of scope.
    // Treating it as third-party let a cross-package cycle planted through an
    // unexported subpath report "No source cycles" with exit 0.
    if (bare.startsWith(WORKSPACE_SCOPE)) {
      return { unresolved: true };
    }
    // Anything else is a third-party package. Scope is decided by the SAME
    // alias list used to resolve, so the two can no longer disagree.
    return { outOfScope: true };
  }

  const candidate = isRelative ? path.resolve(path.dirname(fromFile), bare) : aliased;
  const file = resolveSourceFile(candidate);
  if (file !== null) {
    return { file };
  }

  // `new URL('./x', import.meta.url)` legitimately names non-module assets
  // (.wasm, images, fonts). An `import` must resolve to a module; an asset
  // reference need not, so only the former counts as a dropped edge.
  return isAssetReference ? { outOfScope: true } : { unresolved: true };
}

/**
 * Walk ONE app's renderer source graph and report its cycles.
 *
 * Traversal has two kinds of successor. STATIC imports are graph EDGES — they
 * are what creates init order, and therefore what a cycle is made of. Dynamic
 * `import()` and Vite `?worker`/`?url` imports are traversal ROOTS: they are not
 * edges (they create no init-order dependency), but their targets are real
 * modules whose own static graphs must still be analyzed. Skipping them
 * entirely, as the first version did, left everything behind a lazy boundary
 * unexamined.
 */
function walkAppGraph({ aliases, entryFile, root }) {
  const graph = new Map();
  const unresolved = new Set();
  const queue = [entryFile];
  const seen = new Set(queue);

  const enqueue = (target) => {
    if (target !== null && !seen.has(target)) {
      seen.add(target);
      queue.push(target);
    }
  };

  while (queue.length > 0) {
    const file = queue.pop();
    const sourceText = readFileSync(file, 'utf8');
    const dependencies = new Set();

    const record = (specifier) => unresolved.add(`${specifier}  (in ${path.relative(root, file)})`);

    for (const specifier of staticImportSpecifiers(sourceText, file)) {
      const outcome = classifySpecifier({ aliases, fromFile: file, specifier });
      if (outcome.unresolved) {
        record(specifier);
        continue;
      }
      if (!outcome.file || outcome.file === file) {
        continue;
      }
      dependencies.add(outcome.file);
      enqueue(outcome.file);
    }

    for (const { kind, specifier } of deferredImportSpecifiers(sourceText, file)) {
      const outcome = classifySpecifier({
        aliases,
        fromFile: file,
        // Only a `new URL(...)` target may legitimately be a non-module asset.
        // A dynamic or `?worker` import that fails to resolve is a dropped
        // ROOT: everything behind that lazy boundary would go unanalyzed.
        isAssetReference: kind === 'url',
        specifier,
      });
      if (outcome.unresolved) {
        record(specifier);
        continue;
      }
      if (!outcome.file) {
        continue;
      }
      // Root, not edge: reached at a later tick, so it cannot participate in
      // this module's initialization order.
      enqueue(outcome.file);
    }

    graph.set(file, dependencies);
  }

  return { graph, unresolved };
}

/**
 * Walk every renderer app's source graph and report their cycles.
 *
 * THROWS rather than returning a clean verdict when the graph collapses below
 * the floor, an entrypoint will not resolve, or ANY in-scope specifier fails to
 * resolve — each means the graph reported on is not the graph that ships.
 */
export async function findSourceCycles({ apps = RENDERER_APPS, root = REPO_ROOT } = {}) {
  const cycles = [];
  const unresolved = new Set();
  let moduleCount = 0;

  for (const app of apps) {
    const entryFile = resolveSourceFile(path.join(root, app.entrypoint));
    if (entryFile === null) {
      throw new Error(
        `Could not resolve the ${app.name} renderer entrypoint (${app.entrypoint}) under ${root}. ` +
          'This guard cannot report a meaningful verdict without it.'
      );
    }

    const aliases = rendererAliasEntries(root, app.overrides);
    const walked = walkAppGraph({ aliases, entryFile, root });
    for (const specifier of walked.unresolved) {
      unresolved.add(specifier);
    }
    moduleCount = Math.max(moduleCount, walked.graph.size);
    for (const cycle of findCycles(walked.graph)) {
      cycles.push(cycle);
    }
  }

  if (moduleCount < MIN_MODULES) {
    throw new Error(
      `Reached only ${moduleCount} source module(s) from the renderer entrypoints, below the floor ` +
        `of ${MIN_MODULES}. Module resolution has probably broken — without this check the guard ` +
        'would report every future tree as clean.'
    );
  }

  const unexpected = [...unresolved].filter(
    (entry) => !EXPECTED_UNRESOLVED.some((allowed) => entry.startsWith(allowed))
  );
  if (unexpected.length > 0) {
    throw new Error(
      'These specifiers did not resolve to a source module, so their edges are missing from the ' +
        `graph:\n- ${unexpected.join('\n- ')}\n` +
        'A missing edge can hide a real cycle. Either teach this guard to resolve them, or add them ' +
        'to EXPECTED_UNRESOLVED with a reason. Usual causes: an app-local vite alias it does not ' +
        'yet mirror; a `@brainstrike/*` subpath the package does not export; or an export that ' +
        'targets built `dist`, which the app would bundle instead of source.'
    );
  }

  // The same cycle can surface from more than one app; report it once.
  const deduped = [...new Map(cycles.map((cycle) => [cycle.join('\0'), cycle])).values()];
  return { cycles: deduped, moduleCount };
}

export async function main({ repoRoot = REPO_ROOT } = {}) {
  const { cycles, moduleCount } = await findSourceCycles({ root: repoRoot });

  if (cycles.length === 0) {
    process.stdout.write(`No source cycles: ${moduleCount} renderer modules reachable\n`);
    return;
  }

  const rendered = cycles
    .map((cycle) => {
      const members = cycle.map((file) => `    - ${path.relative(repoRoot, file)}`).join('\n');
      return `  CYCLE (${cycle.length} modules):\n${members}`;
    })
    .join('\n\n');

  throw new Error(
    'Circular dependency in the renderer SOURCE graph. When these modules land in the same bundle ' +
      'chunk they are concatenated in an arbitrary order, so a module-scope read of one can see the ' +
      "other's binding uninitialized — `Cannot access 'X' before initialization` at startup. The " +
      'chunk-cycle guard cannot see this: one chunk has no cross-chunk edge to flag.\n\n' +
      `${rendered}\n\n` +
      'Most of these are a module importing its OWN package barrel (`@brainstrike/<pkg>`) instead of ' +
      'the sibling module. Import the sibling directly — see the no-barrel/TDZ ruling in ' +
      'docs/agents/platform-contracts.md.'
  );
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main({ repoRoot: parseRepoRootArgument(process.argv.slice(2)) });
}
