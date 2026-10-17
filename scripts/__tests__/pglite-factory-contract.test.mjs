import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const factoryPath = 'packages/db/src/pglite-factory.ts';
// The one other construction site: the snapshot verifier's PGlite (BST-1877), which adds amcheck to the
// engine set. Its own module and package subpath keep amcheck out of every browser bundle.
const verificationFactoryPath = 'packages/db/src/pglite-verification-factory.ts';
const factoryPaths = [factoryPath, verificationFactoryPath];
// Runtime sources that may import it. FORTHCOMING: BST-1877 L2 adds the desktop DB tool entry; until
// then nothing imports the verification factory (the guard below passes with no importer).
const verificationFactoryImporters = ['apps/desktop/src/db-tool-entry.ts'];
function isRuntimeSource(file) {
  return (
    /\.[cm]?[jt]sx?$/u.test(file) &&
    !file.split('/').includes('__tests__') &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
  );
}

function constructionViolations(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  function visit(node) {
    const directConstruction =
      (ts.isNewExpression(node) && node.expression.getText(parsed) === 'PGlite') ||
      (ts.isCallExpression(node) && node.expression.getText(parsed) === 'PGlite.create');
    // Ban runtime access to the vendor constructor too, including namespace
    // imports and the desktop's dynamic-import / PGliteCtor -> Ctor chain.
    const importsCore =
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@electric-sql/pglite' &&
      !node.importClause?.isTypeOnly &&
      !(
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)
      );
    const loadsCore =
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(parsed) === 'require') &&
      node.arguments.some(
        (argument) => ts.isStringLiteral(argument) && argument.text === '@electric-sql/pglite'
      );
    if (directConstruction || importsCore || loadsCore) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      violations.push(`${file}:${line + 1}: ${node.getText(parsed).split('\n')[0]}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

test('PGlite construction belongs exclusively to the two factory modules', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  )
    .trim()
    .split('\n');
  const violations = files
    .filter((file) => isRuntimeSource(file) && !factoryPaths.includes(file))
    // `--cached` lists tracked paths even when deleted in the worktree; skip those.
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .flatMap((file) => {
      const source = readFileSync(path.join(repoRoot, file), 'utf8');
      // Cheap pre-filter: nothing without this text can construct or import PGlite,
      // so the full AST parse runs only on the handful of candidate files.
      return source.includes('PGlite') || source.includes('@electric-sql/pglite')
        ? constructionViolations(file, source)
        : [];
    });
  assert.deepEqual(
    violations,
    [],
    `Construct only through ${factoryPaths.join(' or ')}:\n${violations.join('\n')}`
  );
});

test('only the desktop DB tool process may import the amcheck verification factory', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter((file) => existsSync(path.join(repoRoot, file)));
  // Control: the sweep must see the module itself, or an empty result below proves nothing.
  assert.ok(files.includes(verificationFactoryPath));
  const importers = files.filter(
    (file) =>
      isRuntimeSource(file) &&
      !factoryPaths.includes(file) &&
      readFileSync(path.join(repoRoot, file), 'utf8').includes('pglite-verification-factory')
  );
  assert.deepEqual(
    importers.filter((file) => !verificationFactoryImporters.includes(file)),
    [],
    'amcheck must stay out of browser bundles: only the desktop DB tool process imports the verification factory'
  );
});

test('amcheck is imported only by the verification factory, never directly', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter((file) => existsSync(path.join(repoRoot, file)));
  const importers = files.filter(
    (file) =>
      isRuntimeSource(file) &&
      file !== verificationFactoryPath &&
      readFileSync(path.join(repoRoot, file), 'utf8').includes(
        '@electric-sql/pglite/contrib/amcheck'
      )
  );
  assert.deepEqual(
    importers,
    [],
    `Load amcheck only through ${verificationFactoryPath}, so no other module can put it in a bundle`
  );
});

test('the source sweep includes benchmarks and future runtime sites, preserving deliberate test fixtures', () => {
  for (const file of [
    'apps/new/src/db.ts',
    'packages/new/src/db.mjs',
    'scripts/bench.ts',
    'packages/db/scripts/benchmark-binary-quantization.ts',
  ]) {
    assert.ok(isRuntimeSource(file), file);
  }
  for (const file of [
    'packages/db/__tests__/helpers/bare-db.ts',
    'apps/new/src/db.test.ts',
    'packages/new/db.integration.spec.ts',
  ]) {
    assert.equal(isRuntimeSource(file), false, file);
  }
});

test('guard catches constructors, static creation, and constructor aliases but ignores comments and types', () => {
  assert.equal(
    constructionViolations(
      'example.ts',
      '// new PGlite()\nimport type { PGlite } from "@electric-sql/pglite";'
    ).length,
    0
  );
  for (const source of [
    'new PGlite({})',
    'PGlite.create({})',
    'import { PGlite as Database } from "@electric-sql/pglite";',
    'const { PGlite: Database } = await import("@electric-sql/pglite");',
    'import * as vendor from "@electric-sql/pglite";',
    'const vendor = require("@electric-sql/pglite");',
  ]) {
    assert.ok(constructionViolations('example.ts', source).length > 0, source);
  }
});
