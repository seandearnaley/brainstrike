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
// invisible. A first measurement built this way saw 139 modules; going through
// `packages/test-utils/workspace-src-aliases.mjs` saw 768. That registry is the
// repo's single source of truth for `@brainstrike/* -> src` and exists for the
// same stale-dist incident class (#1066/#1207).
//
// STATIC, NON-TYPE IMPORTS ONLY:
//   - `import type` / type-only specifiers are erased and never affect init order.
//   - dynamic `import()` creates no init-order dependency, so it cannot form this
//     hazard; counting it would flag cycles that physically cannot fire.
//   - a bare side-effect `import '…'` DOES affect init order and counts.
//
// Full rationale: docs/superpowers/specs/2026-07-25-chunk-cycle-invariant-design.md

import { existsSync, readFileSync, statSync } from 'node:fs';
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

/** Renderer entrypoints. Their union is the graph this guard governs. */
const ENTRYPOINTS = ['apps/web/src/main.tsx', 'apps/desktop/src/renderer/main.tsx'];

/**
 * Anti-vacuous floor (BST-836: an instrument that cannot fail is not evidence).
 * Measured at 768 modules from the web entry alone. If a resolution change or a
 * bad entry path collapses the graph, that must fail loudly rather than report
 * "no cycles" forever.
 */
const MIN_MODULES = 400;

/**
 * `@brainstrike/*` specifiers that legitimately resolve to no source module.
 *
 * Stylesheets are not modules in the init-order sense, so they are not edges.
 * This is an exact set, not a tolerated count: a NEW unresolved specifier fails
 * loudly, because a silently dropped edge can hide a real cycle — which is the
 * one failure this guard must never have.
 */
const EXPECTED_UNRESOLVED = Object.freeze([
  '@brainstrike/app-shell/styles.css',
  '@brainstrike/db-explorer/styles.css',
  '@brainstrike/file-explorer-ui/styles.css',
  '@brainstrike/ui/globals.css',
  '@brainstrike/ui/styles.css',
  '@brainstrike/workspace-search/styles.css',
]);

/**
 * `@brainstrike/workers` has no `src/` dir — its worker modules live at the
 * package root — so the shared registry skips it and every consumer aliases its
 * subpaths explicitly. Mirror that here rather than dropping the edges.
 */
function workersAliasEntries(root) {
  return [{ find: '@brainstrike/workers', replacement: path.join(root, 'packages/workers') }];
}

/**
 * Resolution mirrors what the renderer builds actually do, composed from the
 * repo's own helpers rather than reinvented:
 *
 * - `createAgentBrowserSafeAliasEntries` — `@brainstrike/agent` is deliberately
 *   excluded from the shared registry (its root and most subpaths pull Node-only
 *   Mastra deps), and the curated browser-safe subpaths are what a renderer may
 *   actually import. `apps/web/vite.config.mts` composes these two the same way.
 * - `workspaceSrcAliases` — every other `@brainstrike/*` package to SOURCE, not
 *   built `dist`.
 *
 * Order matters: exact agent subpaths first, then workers, then the registry,
 * matching the first-match semantics `resolveThroughAliases` simulates.
 */
function rendererAliasEntries(root) {
  return [
    ...createAgentBrowserSafeAliasEntries(path.join(root, 'packages/agent')),
    ...workersAliasEntries(root),
    ...workspaceSrcAliases(path.join(root, 'packages')),
  ];
}

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/** Probe a path as a file, then with each extension, then as a directory index. */
export function resolveSourceFile(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
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
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
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
      specifiers.push(statement.moduleSpecifier.text);
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
export async function findSourceCycles({ root = REPO_ROOT, entrypoints = ENTRYPOINTS } = {}) {
  const aliases = rendererAliasEntries(root);
  const graph = new Map();
  const unresolved = new Set();

  const queue = entrypoints
    .map((entry) => resolveSourceFile(path.join(root, entry)))
    .filter((entry) => entry !== null);
  if (queue.length !== entrypoints.length) {
    throw new Error(
      `Could not resolve every renderer entrypoint under ${root}: expected ${entrypoints.length}, ` +
        `resolved ${queue.length}. Entrypoints: ${entrypoints.join(', ')}. This guard cannot report ` +
        'a meaningful verdict without them.'
    );
  }
  const seen = new Set(queue);

  while (queue.length > 0) {
    const file = queue.pop();
    const dependencies = new Set();
    for (const specifier of staticImportSpecifiers(readFileSync(file, 'utf8'), file)) {
      let target = null;
      if (specifier.startsWith('.')) {
        target = resolveSourceFile(path.resolve(path.dirname(file), specifier));
      } else if (specifier.startsWith('@brainstrike/')) {
        const aliased = resolveThroughAliases(specifier, aliases);
        target = aliased === null ? null : resolveSourceFile(aliased);
        if (target === null) {
          unresolved.add(specifier);
        }
      }
      if (target === null || target === file) {
        continue;
      }
      dependencies.add(target);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
    graph.set(file, dependencies);
  }

  if (graph.size < MIN_MODULES) {
    throw new Error(
      `Reached only ${graph.size} source module(s) from the renderer entrypoints, below the floor ` +
        `of ${MIN_MODULES}. Module resolution has probably broken — without this check the guard ` +
        'would report every future tree as clean.'
    );
  }

  const unexpected = [...unresolved].filter(
    (specifier) => !EXPECTED_UNRESOLVED.includes(specifier)
  );
  if (unexpected.length > 0) {
    throw new Error(
      'These @brainstrike/* specifiers did not resolve to a source module, so their edges are ' +
        `missing from the graph:\n- ${unexpected.join('\n- ')}\n` +
        'A missing edge can hide a real cycle. Either teach the alias registry to resolve them, or ' +
        'add them to EXPECTED_UNRESOLVED in this guard with a reason.'
    );
  }

  return { cycles: findCycles(graph), moduleCount: graph.size };
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
  await main();
}
