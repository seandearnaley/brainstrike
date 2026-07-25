#!/usr/bin/env node

// Guard: nothing may read a `mastra-memory-schema` constant during MODULE-SCOPE
// evaluation (BST-558).
//
// THE DEFECT THIS EXISTS FOR, measured on PR #1978 and not theorised:
// `packages/app-shell/src/assistant-memory-repository.ts` built its bootstrap
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
// This supersedes `scripts/__tests__/mastra-workflow-table-literal-contract.test.mjs`,
// a stopgap that pinned one hand-copied literal in one file and forbade one
// import syntax there. That guard could not see `export … from`, `await
// import()`, or the same import added from any other renderer module, and it
// protected the file that TRIPPED the defect rather than the files that CONTAIN
// it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The module that owns the constants. Exempt: it reads its OWN local consts. */
const SCHEMA_MODULE = 'packages/assistant-contract/src/mastra-memory-schema.ts';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  // Tests are never bundled into a renderer chunk graph: Vitest and Playwright
  // evaluate modules in dependency order, so a module-scope read there cannot
  // reproduce this defect and forbidding it would be noise.
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
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
 * Local names bound to a guarded constant by a VALUE import in this file.
 *
 * Matched on the IMPORTED name, not the module specifier, so a re-export hop
 * (`packages/agent/src/pglite-mastra-memory/sql.ts` re-exports the whole set)
 * is covered without teaching this guard every alias path. `import type` and
 * type-only specifiers are skipped: they are erased and never read at runtime.
 */
function collectGuardedLocalNames(sourceFile, guarded) {
  const locals = new Map();
  for (const statement of sourceFile.statements) {
    if (!(ts.isImportDeclaration(statement) && statement.importClause)) {
      continue;
    }
    if (isTypeOnlyImportClause(statement.importClause)) {
      continue;
    }
    const named = statement.importClause.namedBindings;
    if (!(named && ts.isNamedImports(named))) {
      continue;
    }
    for (const element of named.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const importedName = (element.propertyName ?? element.name).text;
      if (guarded.has(importedName)) {
        locals.set(element.name.text, importedName);
      }
    }
  }
  return locals;
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
  const locals = collectGuardedLocalNames(sourceFile, guarded);
  if (locals.size === 0) {
    return [];
  }

  const reads = [];
  const walk = (node) => {
    if (isFunctionLike(node)) {
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const clause of node.heritageClauses ?? []) {
        walk(clause);
      }
      return;
    }
    if (ts.isIdentifier(node) && locals.has(node.text)) {
      // A property NAME (`foo.MASTRA_MEMORY_TABLES`) or an object key is not a
      // read of the imported binding.
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        reads.push({ binding: locals.get(node.text), line: line + 1, local: node.text });
      }
      return;
    }
    ts.forEachChild(node, walk);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) {
          walk(declaration.initializer);
        }
      }
    } else if (ts.isExpressionStatement(statement)) {
      walk(statement.expression);
    } else if (ts.isClassDeclaration(statement)) {
      for (const clause of statement.heritageClauses ?? []) {
        walk(clause);
      }
    }
  }
  return reads;
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
  return findModuleScopeReads(sourceFile, new Set(guardedNames));
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

  const sourceFiles = await glob(SOURCE_PATTERNS, {
    absolute: false,
    cwd: root,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    posix: true,
  });
  if (sourceFiles.length < MIN_SOURCE_FILES) {
    throw new Error(
      `Discovered only ${sourceFiles.length} source file(s) under ${root}, below the floor of ` +
        `${MIN_SOURCE_FILES}. This guard cannot report a meaningful verdict on that tree.`
    );
  }

  const violations = [];
  for (const filePath of sourceFiles.sort()) {
    if (filePath === SCHEMA_MODULE) {
      continue;
    }
    const text = await readFile(path.join(root, filePath), 'utf8');
    // Cheap pre-filter: parsing every file in the monorepo is the slow path.
    if (!text.includes('mastra')) {
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
  }
  return violations;
}

export async function main({ repoRoot = REPO_ROOT } = {}) {
  const violations = await findMastraSchemaModuleScopeReads({ root: repoRoot });

  if (violations.length === 0) {
    console.log('No module-scope reads of mastra-memory-schema constants found.');
    return;
  }

  console.error(
    'Mastra memory-schema constants are read during module-scope evaluation. Bundle chunk order ' +
      'does not guarantee the contract chunk has initialized at that point, so the binding can be ' +
      'undefined: a property access throws and kills the renderer at startup, and a bare ' +
      'interpolation silently splices "undefined" into SQL. Move the read inside the function that ' +
      'uses it (build SQL where you execute it):'
  );
  for (const violation of violations) {
    const alias =
      violation.local === violation.binding
        ? violation.binding
        : `${violation.binding} as ${violation.local}`;
    console.error(`- ${violation.filePath}:${violation.line} (${alias})`);
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
