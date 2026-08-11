import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const helperPath = new URL('../../apps/desktop/e2e/utils/layout-helpers.ts', import.meta.url);
const persistenceSpecPath = new URL(
  '../../apps/desktop/e2e/database-persistence.test.ts',
  import.meta.url
);

function findPostCleanupDatabaseErrorSkips(source) {
  const sourceFile = ts.createSourceFile(
    'database-persistence.test.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations = [];
  const functions = [];

  function visitFunctions(node) {
    if (ts.isFunctionLike(node)) {
      functions.push(node);
    }
    ts.forEachChild(node, visitFunctions);
  }

  function getLocalFunctionName(node) {
    if (node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    return;
  }

  function findDirectCalls(node, callableNames) {
    const calls = [];

    function inspect(current) {
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        callableNames.has(current.expression.text)
      ) {
        calls.push(current);
      }
      ts.forEachChild(current, inspect);
    }

    inspect(node);
    return calls;
  }

  function findDatabaseErrorCall(node) {
    let match;

    function inspect(current) {
      if (match || (current !== node && ts.isFunctionLike(current))) {
        return;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === 'isDatabaseError'
      ) {
        match = current;
        return;
      }
      ts.forEachChild(current, inspect);
    }

    inspect(node);
    return match;
  }

  function containsReturn(node) {
    let found = false;

    function inspect(current) {
      if (found || (current !== node && ts.isFunctionLike(current))) {
        return;
      }
      if (ts.isReturnStatement(current)) {
        found = true;
        return;
      }
      ts.forEachChild(current, inspect);
    }

    inspect(node);
    return found;
  }

  visitFunctions(sourceFile);
  const cleanupWrapperNames = new Set(
    functions
      .filter((node) => findDirectCalls(node, new Set(['clearDatabaseRecords'])).length > 0)
      .map(getLocalFunctionName)
      .filter((name) => name !== undefined)
  );
  const cleanupCallableNames = new Set(['clearDatabaseRecords', ...cleanupWrapperNames]);

  function inspectFunction(node) {
    const cleanupCalls = findDirectCalls(node, cleanupCallableNames);
    if (cleanupCalls.length === 0) {
      return;
    }
    const firstCleanupCall = Math.min(...cleanupCalls.map((call) => call.getStart(sourceFile)));

    function inspectBody(current) {
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (ts.isIfStatement(current) && containsReturn(current.thenStatement)) {
        const databaseErrorCall = findDatabaseErrorCall(current.expression);
        if (databaseErrorCall && databaseErrorCall.getStart(sourceFile) > firstCleanupCall) {
          const location = sourceFile.getLineAndCharacterOfPosition(
            databaseErrorCall.getStart(sourceFile)
          );
          violations.push(`${location.line + 1}:${location.character + 1}`);
        }
      }
      ts.forEachChild(current, inspectBody);
    }

    inspectBody(node);
  }
  for (const node of functions) {
    inspectFunction(node);
  }
  return violations;
}

test('desktop database cleanup fails closed when cleanup cannot be verified', async () => {
  const source = await readFile(helperPath, 'utf8');
  assert.match(
    source,
    /function failClosedOnUnverifiedCleanup\(reason: string\): never \{\s*throw new Error\(`Database cleanup could not be verified: \$\{reason\}; records were not cleared\.`\);\s*\}/,
    'unverified cleanup must throw its caller-provided failure reason'
  );

  for (const invocationPattern of [
    /failClosedOnUnverifiedCleanup\(`bulk delete threw: \$\{[^}]+\}`\);/,
    /failClosedOnUnverifiedCleanup\(`bulk delete failed: \$\{[^}]+\}`\);/,
    /failClosedOnUnverifiedCleanup\(`record-count verification threw: \$\{[^}]+\}`\);/,
    /failClosedOnUnverifiedCleanup\(\s*'bulk delete reported success but the remaining record count could not be verified'\s*\);/,
    /failClosedOnUnverifiedCleanup\(\s*`bulk delete reported success but left \$\{[^}]+\} records`\s*\);/,
  ]) {
    assert.match(
      source,
      invocationPattern,
      `the cleanup caller must invoke the fail-closed helper: ${invocationPattern}`
    );
  }

  assert.doesNotMatch(
    source,
    /Using UI-based deletion fallback|falling back to UI deletion/,
    'logs must not claim the removed UI deletion path will run'
  );
});

test('database persistence specs do not treat fail-closed cleanup as a graceful skip', async () => {
  const source = await readFile(persistenceSpecPath, 'utf8');
  const violations = findPostCleanupDatabaseErrorSkips(source);
  assert.deepEqual(
    violations,
    [],
    `a failed cleanup must surface instead of reaching a later database-error skip in the same function; violations: ${violations.join(', ')}`
  );
});

test('cleanup-skip contract follows local wrappers and ignores non-returning error checks', () => {
  const source = `
    async function cleanupRecords(page: Page) {
      const cleaned = await clearDatabaseRecords(page);
      return cleaned;
    }

    async function cleanup(page: Page) {
      const cleaned = await cleanupRecords(page);
      await clickRefreshIfAvailable(cleaned);
      // A comment or renamed result must not hide the post-cleanup skip.
      if (await isDatabaseError(cleaned)) return cleaned;
      return cleaned;
    }

    async function observe(page: Page) {
      const cleaned = await clearDatabaseRecords(page);
      const hasError = await isDatabaseError(cleaned);
      expect(hasError).toBe(false);
    }
  `;

  assert.deepEqual(findPostCleanupDatabaseErrorSkips(source), ['11:17']);
});
