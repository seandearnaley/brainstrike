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

  function inspectFunction(node) {
    const cleanupCalls = [];
    const databaseErrorCalls = [];

    function inspectBody(current) {
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === 'clearDatabaseRecords'
      ) {
        cleanupCalls.push(current.getStart(sourceFile));
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === 'isDatabaseError'
      ) {
        databaseErrorCalls.push(current.getStart(sourceFile));
      }
      ts.forEachChild(current, inspectBody);
    }

    inspectBody(node);
    const firstCleanupCall = Math.min(...cleanupCalls);
    const postCleanupErrorCall = databaseErrorCalls.find((position) => position > firstCleanupCall);
    if (cleanupCalls.length === 0 || postCleanupErrorCall === undefined) {
      return;
    }

    const location = sourceFile.getLineAndCharacterOfPosition(postCleanupErrorCall);
    violations.push(`${location.line + 1}:${location.character + 1}`);
  }

  function visit(node) {
    if (ts.isFunctionLike(node)) {
      inspectFunction(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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

test('cleanup-skip contract catches renamed results and intervening statements', () => {
  const source = `
    async function cleanup(page: Page) {
      const cleaned = await clearDatabaseRecords(page);
      await clickRefreshIfAvailable(cleaned);
      // A comment or renamed result must not hide the post-cleanup skip.
      if (await isDatabaseError(cleaned)) return cleaned;
      return cleaned;
    }
  `;

  assert.deepEqual(findPostCleanupDatabaseErrorSkips(source), ['6:17']);
});
