#!/usr/bin/env node

// Guard: nothing may read a `mastra-memory-schema` constant during MODULE-SCOPE
// evaluation (BST-558).
//
// THE DEFECT THIS EXISTS FOR, measured on PR #1978 and not theorised:
// `packages/assistant-data/src/assistant-memory-repository.ts` built its bootstrap
// DDL in a module-scope template literal that interpolated
// `MASTRA_MEMORY_TABLES.threads`. Module-scope initializers run at CHUNK
// INITIALIZATION, and the renderer's bundle chunk graph does not guarantee the
// contract chunk has evaluated by then. Adding ONE unrelated static import of
// `@brainstrike/assistant-contract/mastra-memory-schema` to
// `packages/db/src/db-provider.tsx` reordered chunk init: commit `df953a2a8` was
// green, `3e8d1b7fd` (identical but for that import) turned Web E2E and Desktop
// E2E red with `Cannot read properties of undefined (reading 'threads')`, and
// the app never became ready.
//
// WHY A DEDICATED GUARD, i.e. why nothing else catches this:
//   - `tsc` cannot: ESM live bindings type identically either way.
//   - lint cannot: there is no lint rule for chunk-evaluation order.
//   - unit tests cannot: Vitest evaluates real modules in dependency order, so
//     the binding is always defined. The schema module imports NOTHING, so there
//     is no source cycle for a cycle detector to find either.
//   - only a PRODUCTION BUILD has a chunk graph, so only E2E observes it — after
//     the fact, as a startup crash with no pointer to the cause.
//
// The failure is not always loud, which is the other reason to guard it
// statically. `${MASTRA_MEMORY_TABLES.threads}` throws; but interpolating a bare
// uninitialized binding such as `${MASTRA_VECTOR_TABLE}` splices the literal
// string "undefined" into the DDL, silently creating and querying a table named
// `undefined`.
//
// THE RULE: import these constants freely — the import edge itself is fine — but
// read them only from inside a function body, where every chunk has already been
// evaluated. Build SQL in the function that executes it.
//
// SCOPE: this guard covers ONE constant family — the exports of the schema
// module below. That is a floor, not a ceiling. The same class has already bitten
// an unrelated family (the context-action helpers, PR #1292), which is held today
// only by a `codeSplitting.groups` entry in `apps/web/vite.config.mts`.
// Generalizing was BST-861/BST-890, delivered as TWO structural backstops rather
// than a wider AST rule — a module-scope read is only dangerous when a cycle
// exists, and both halves of that precondition are now asserted:
//   scripts/verify-no-cross-chunk-cycles.mjs  (build) — acyclic CHUNK graph
//   scripts/verify-no-source-cycles.mjs       (lint)  — acyclic SOURCE graph
// A naive "flag every module-scope read of an imported binding" AST rule returns
// 431 hits in `app-shell` + `db` alone, nearly all benign, because the CHUNK
// (not the file, not the package) is the unit of risk for the cross-chunk form.
//
// Migration 066's `QUALIFIED_PG_TEXTSEARCH_VERSION` used to be listed here as a
// live instance outside this scope. It is NOT open work: BST-860 was
// investigated and closed won't-do — the obvious fix breaks production startup,
// and the two guards above make the read unreachable. Do not "fix" it; see
// docs/agents/platform-contracts.md for the full reasoning.
//
// This supersedes `scripts/__tests__/mastra-workflow-table-literal-contract.test.mjs`,
// a stopgap that pinned one hand-copied literal in one file and forbade one
// import syntax there. That guard could not see `export … from`, `await
// import()`, or the same import added from any other renderer module, and it
// protected the file that TRIPPED the defect rather than the files that CONTAIN
// it.

import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The module that owns the constants. Exempt: it reads its OWN local consts. */
const SCHEMA_MODULE = 'packages/assistant-contract/src/mastra-memory-schema.ts';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
];

const IGNORE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/.turbo',
  '**/.turbo/**',
  '**/coverage',
  '**/coverage/**',
  '**/playwright-report',
  '**/playwright-report/**',
  '**/test-results',
  '**/test-results/**',
  // Tests are never bundled into a renderer chunk graph: Vitest and Playwright
  // evaluate modules in dependency order, so a module-scope read there cannot
  // reproduce this defect and forbidding it would be noise.
  '**/__tests__',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/e2e',
  '**/e2e/**',
];

// A discovery floor, per the BST-836 lesson that an instrument which cannot fail
// is not evidence. If the glob or the export scrape silently returns nothing,
// every check below passes while checking precisely zero things.
const MIN_SOURCE_FILES = 200;
const MIN_GUARDED_BINDINGS = 5;

/**
 * The guarded names are SCRAPED from the schema module, never hand-listed, so a
 * constant added there is covered the day it lands.
 */
export async function readGuardedBindings({ root = REPO_ROOT } = {}) {
  let source;
  try {
    source = await readFile(path.join(root, SCHEMA_MODULE), 'utf8');
  } catch (cause) {
    // Refuse loudly. Treating an unreadable schema module as "no constants to
    // guard" would make this script exit 0 on any tree it cannot read, which is
    // precisely the vacuous green BST-836 was about.
    throw new Error(
      `Cannot read ${SCHEMA_MODULE} under ${root}, so the guarded constant set is unknown and no ` +
        'verdict is possible. If the schema module moved, update SCHEMA_MODULE in this guard.',
      { cause }
    );
  }
  const names = [...source.matchAll(/^export const ([A-Z][A-Z0-9_]*)\s*=/gm)].map(
    (match) => match[1]
  );
  return new Set(names);
}

/**
 * `import type { … }` detection across TypeScript versions: TS 6 replaced
 * `ImportClause.isTypeOnly` with the more general `phaseModifier` (which also
 * carries `import defer`). Read the new field first and fall back, so a
 * toolchain bump cannot silently turn this check into a no-op.
 */
function isTypeOnlyImportClause(importClause) {
  if (importClause.phaseModifier !== undefined) {
    return importClause.phaseModifier === ts.SyntaxKind.TypeKeyword;
  }
  return importClause.isTypeOnly === true;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Local bindings in this file that can carry a guarded constant.
 *
 * Two shapes, because they need different matching:
 *
 * - `direct`: `import { MASTRA_VECTOR_TABLE as T }` → local name -> constant.
 *   Matched on the IMPORTED name, never the module specifier, so a re-export hop
 *   (`packages/agent/src/pglite-mastra-memory/sql.ts` re-exports the whole set)
 *   is covered without teaching this guard every alias path.
 * - `namespaces`: `import * as schema` / `import schema from`. There is no
 *   imported name to match, so these are matched at the USE site instead — a
 *   module-scope `schema.MASTRA_VECTOR_TABLE` is flagged by property name. Any
 *   namespace local counts, deliberately: narrowing by specifier is what would
 *   miss the re-export hops this guard exists to cover, and a module-scope read
 *   of an imported namespace's `MASTRA_*` property is worth flagging regardless
 *   of which module it came from.
 *
 * `import type` and type-only specifiers are skipped: they are erased and never
 * read at runtime.
 *
 * `export { X } from '…'` is deliberately NOT collected. A re-export links a
 * binding, it does not READ one, so it cannot itself throw or splice
 * "undefined" into SQL. It can still perturb chunking — but this guard protects
 * the crash SITES, which is what makes any chunk order survivable.
 */
function collectGuardedLocalNames(sourceFile, guarded) {
  const direct = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!(ts.isImportDeclaration(statement) && statement.importClause)) {
      continue;
    }
    const importClause = statement.importClause;
    if (isTypeOnlyImportClause(importClause)) {
      continue;
    }
    if (importClause.name) {
      namespaces.add(importClause.name.text);
    }
    const named = importClause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
    }
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const importedName = (element.propertyName ?? element.name).text;
        if (guarded.has(importedName)) {
          direct.set(element.name.text, importedName);
        }
      }
    }
  }
  return { direct, namespaces };
}

/**
 * Cheap pre-filter deciding whether a file is worth parsing.
 *
 * Tests for the GUARDED NAMES themselves, never a `'mastra'` substring. The
 * substring version silently skipped real violations twice over: it was
 * case-sensitive while every guarded name is upper-case (so
 * `packages/agent/src/pglite-mastra-memory/schema.ts`, which re-exports four of
 * them and contains no lower-case `mastra` at all, was never parsed — the
 * directory name is in the PATH, not the text), and three guarded constants
 * (`DEFAULT_THREAD_TITLE`, `THREAD_TITLE_SOURCE_*`) contain no `mastra` in any
 * case. Matching the names is both exact and cheaper than a parse.
 *
 * Exported so the paired test can pin that regression directly: it is invisible
 * to the per-source detector, which never pre-filters.
 */
export function shouldScanSource(text, guardedNames) {
  return guardedNames.some((name) => text.includes(name));
}

/** Unwrap `(fn)` / `(fn as T)` so a parenthesized IIFE callee is still seen. */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Report guarded reads reachable during module-scope evaluation.
 *
 * Descends initializers of top-level declarations, top-level expression
 * statements, and class heritage clauses — but STOPS at every function
 * boundary, because a function body runs after all chunks are initialized.
 * That distinction is the whole point: `const SQL = \`…${T.x}…\`` is the bug,
 * `const f = () => \`…${T.x}…\`` is the fix, and they are textually identical
 * to a grep.
 */
function findModuleScopeReads(sourceFile, guarded) {
  const { direct, namespaces } = collectGuardedLocalNames(sourceFile, guarded);
  if (direct.size === 0 && namespaces.size === 0) {
    return [];
  }

  const reads = [];
  const record = (node, binding, local) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    reads.push({ binding, line: line + 1, local });
  };

  const walk = (node) => {
    // An IIFE's body DOES run at module scope, so it must be walked eagerly.
    // This is the `const X = (() => …)()` "module-scope memo" shape — exactly
    // what the fix comments warn against reintroducing — and skipping it
    // because the callee is function-like would be the guard's worst blind spot.
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (callee && isFunctionLike(callee) && callee.body) {
        walk(callee.body);
      }
    }
    if (isFunctionLike(node)) {
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // Everything that evaluates when the CLASS DEFINITION is evaluated — i.e.
      // at module init — must be walked. Instance member VALUES do not, but
      // their decorators and computed KEYS do: a computed key is evaluated once,
      // at class-definition time, whether or not the member is static.
      for (const clause of node.heritageClauses ?? []) {
        walk(clause);
      }
      for (const modifier of node.modifiers ?? []) {
        if (ts.isDecorator(modifier)) {
          walk(modifier);
        }
      }
      for (const member of node.members) {
        if (ts.isClassStaticBlockDeclaration(member)) {
          walk(member.body);
          continue;
        }
        for (const modifier of member.modifiers ?? []) {
          if (ts.isDecorator(modifier)) {
            walk(modifier);
          }
        }
        if (member.name && ts.isComputedPropertyName(member.name)) {
          walk(member.name.expression);
        }
        const isStatic = member.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
        );
        if (isStatic && ts.isPropertyDeclaration(member) && member.initializer) {
          walk(member.initializer);
        }
      }
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      // `schema.MASTRA_VECTOR_TABLE` on a namespace/default import: matched by
      // PROPERTY name, since a namespace import exposes no imported name to key
      // off. Without this, one `import * as` turns a whole file into a blind
      // spot (review, PR #1988).
      const target = unwrapExpression(node.expression);
      const propertyName = node.name.text;
      if (
        target &&
        ts.isIdentifier(target) &&
        namespaces.has(target.text) &&
        guarded.has(propertyName)
      ) {
        record(node, propertyName, `${target.text}.${propertyName}`);
        return;
      }
    }
    if (ts.isIdentifier(node) && direct.has(node.text)) {
      // A property NAME (`foo.MASTRA_MEMORY_TABLES`) or an object key is not a
      // read of the imported binding.
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) {
        record(node, direct.get(node.text), node.text);
      }
      return;
    }
    ts.forEachChild(node, walk);
  };

  // Walk every top-level statement rather than whitelisting a few kinds. A
  // whitelist missed `export default`, top-level `if`/`for`/`try`, and static
  // class members — all of which run at chunk-init (review, PR #1988). Only
  // declarations whose bodies do NOT execute on evaluation are skipped.
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      continue;
    }
    walk(statement);
  }
  return reads;
}

/**
 * Guarded constants re-exported under a DIFFERENT name.
 *
 * This guard matches by name, everywhere, on purpose — that is what makes
 * re-export hops work without enumerating alias paths. A RENAMED re-export
 * (`export { MASTRA_VECTOR_TABLE as VECTORS } from './sql'`) breaks that
 * premise: a downstream consumer then writes `import { VECTORS }`, its text
 * mentions no guarded name, and both the pre-filter and the detector miss it
 * silently — the guard would report clean on exactly the hazard it exists for.
 *
 * Rather than chase rename chains through module resolution, the rename itself
 * is the violation: keep these constants spelled as themselves at every hop and
 * name-matching stays complete. No such rename exists in the repo today; this
 * stops one being introduced (review, PR #1988). Local aliasing at the point of
 * USE (`import { X as Y }`) is unaffected — the imported name is still spelled.
 */
function findRenamedGuardedReExports(sourceFile, guarded) {
  const renames = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      continue;
    }
    const clause = statement.exportClause;
    if (!(clause && ts.isNamedExports(clause))) {
      continue;
    }
    for (const element of clause.elements) {
      if (element.isTypeOnly || !element.propertyName) {
        continue;
      }
      const exportedFrom = element.propertyName.text;
      const exportedAs = element.name.text;
      if (guarded.has(exportedFrom) && exportedFrom !== exportedAs) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
        renames.push({ binding: exportedFrom, line: line + 1, local: exportedAs, rename: true });
      }
    }
  }
  return renames;
}

/**
 * Analyze one module's source text. Exported so the paired test can drive the
 * detector over fixtures — including the false-positive controls that prove a
 * read inside a function body is NOT reported, which is the entire distinction
 * this guard exists to make.
 */
export function findModuleScopeReadsInSource(text, guardedNames, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  );
  const guarded = new Set(guardedNames);
  return [
    ...findModuleScopeReads(sourceFile, guarded),
    ...findRenamedGuardedReExports(sourceFile, guarded),
  ];
}

/**
 * Scan a source tree. Returns `{ filePath, line, binding, local }` violations.
 * Throws when discovery falls below its floors — a silently empty scan must not
 * read as a pass.
 */
export async function findMastraSchemaModuleScopeReads({ root = REPO_ROOT } = {}) {
  const guarded = await readGuardedBindings({ root });
  if (guarded.size < MIN_GUARDED_BINDINGS) {
    throw new Error(
      `Scraped only ${guarded.size} exported constant(s) from ${SCHEMA_MODULE}, below the floor of ` +
        `${MIN_GUARDED_BINDINGS}. Either the module moved or its "export const NAME =" shape changed; ` +
        'teach this guard the new shape rather than letting it check nothing.'
    );
  }

  const sourceFiles = (
    await Array.fromAsync(
      glob(SOURCE_PATTERNS, {
        cwd: root,
        exclude: IGNORE_PATTERNS,
        withFileTypes: true,
      })
    )
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    );
  if (sourceFiles.length < MIN_SOURCE_FILES) {
    throw new Error(
      `Discovered only ${sourceFiles.length} source file(s) under ${root}, below the floor of ` +
        `${MIN_SOURCE_FILES}. This guard cannot report a meaningful verdict on that tree.`
    );
  }

  const guardedNames = [...guarded];
  const violations = [];
  for (const filePath of sourceFiles.sort()) {
    if (filePath === SCHEMA_MODULE) {
      continue;
    }
    const text = await readFile(path.join(root, filePath), 'utf8');
    if (!shouldScanSource(text, guardedNames)) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    );
    for (const read of findModuleScopeReads(sourceFile, guarded)) {
      violations.push({ filePath, ...read });
    }
    for (const rename of findRenamedGuardedReExports(sourceFile, guarded)) {
      violations.push({ filePath, ...rename });
    }
  }
  return violations;
}

export async function main({ repoRoot = REPO_ROOT } = {}) {
  const violations = await findMastraSchemaModuleScopeReads({ root: repoRoot });

  if (violations.length === 0) {
    console.log('No module-scope reads of mastra-memory-schema constants found.');
    return;
  }

  const reads = violations.filter((violation) => !violation.rename);
  const renames = violations.filter((violation) => violation.rename);

  if (reads.length > 0) {
    console.error(
      'Mastra memory-schema constants are read during module-scope evaluation. Bundle chunk order ' +
        'does not guarantee the contract chunk has initialized at that point, so the binding can be ' +
        'undefined: a property access throws and kills the renderer at startup, and a bare ' +
        'interpolation silently splices "undefined" into SQL. Move the read inside the function that ' +
        'uses it (build SQL where you execute it):'
    );
    for (const violation of reads) {
      const alias =
        violation.local === violation.binding
          ? violation.binding
          : `${violation.binding} as ${violation.local}`;
      console.error(`- ${violation.filePath}:${violation.line} (${alias})`);
    }
  }

  if (renames.length > 0) {
    console.error(
      'Mastra memory-schema constants are RE-EXPORTED under a different name. This guard matches by ' +
        'name at every hop, which is what lets it follow re-exports without enumerating alias paths; ' +
        'a renamed re-export breaks that premise, because a downstream consumer then spells only the ' +
        'new name and is silently never scanned. Re-export them under their own names:'
    );
    for (const violation of renames) {
      console.error(
        `- ${violation.filePath}:${violation.line} (${violation.binding} as ${violation.local})`
      );
    }
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
