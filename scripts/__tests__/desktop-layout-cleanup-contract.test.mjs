import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
  // One local wrapper layer is intentional: this source contract follows the
  // cleanup helpers declared by the spec, not an unbounded call graph.
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
    const databaseErrorAliases = new Map();

    function collectDatabaseErrorAliases(current) {
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (
        ts.isVariableDeclaration(current) &&
        ts.isIdentifier(current.name) &&
        current.initializer
      ) {
        const databaseErrorCall = findDatabaseErrorCall(current.initializer);
        if (databaseErrorCall) {
          databaseErrorAliases.set(current.name.text, databaseErrorCall);
        }
      }
      ts.forEachChild(current, collectDatabaseErrorAliases);
    }

    collectDatabaseErrorAliases(node);

    function inspectBody(current) {
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (ts.isIfStatement(current) && containsReturn(current.thenStatement)) {
        const databaseErrorCall =
          findDatabaseErrorCall(current.expression) ??
          (ts.isIdentifier(current.expression)
            ? databaseErrorAliases.get(current.expression.text)
            : undefined);
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

function findNamedFunctionSource(source, functionName) {
  const sourceFile = ts.createSourceFile(
    'database-persistence.test.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let match;

  function visit(node) {
    if (!match && ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      match = node.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.ok(match, `expected to find function ${functionName}`);
  return match;
}

test('desktop database cleanup fails closed when cleanup cannot be verified', async () => {
  const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
  const { tsImport } = dbRequire('tsx/esm/api');
  const { verifyClearedDesktopContent } = await tsImport(helperPath.href, import.meta.url);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const page = { evaluate: (read) => read() };
  const readFailure = new Error('replacement catalog unavailable');
  const cases = [
    undefined,
    {
      list: async () => {
        throw readFailure;
      },
    },
    { list: async () => ({ error: { message: 'source catalog unavailable' }, ok: false }) },
    ...[null, undefined, 0, -1, Number.NaN, {}, [{ id: 'retained-file' }]].map((value) => ({
      list: async () => ({ ok: true, value }),
    })),
  ];
  try {
    for (const sourceFiles of cases) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { sourceFiles },
      });
      await assert.rejects(() => verifyClearedDesktopContent(page));
    }
    globalThis.window.sourceFiles = {
      list: async () => {
        throw readFailure;
      },
    };
    await assert.rejects(
      () => verifyClearedDesktopContent(page),
      (error) => error === readFailure
    );
    globalThis.window.sourceFiles = { list: async () => ({ ok: true, value: [] }) };
    await verifyClearedDesktopContent(page);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('database persistence specs do not treat fail-closed cleanup as a graceful skip', async () => {
  const source = await readFile(persistenceSpecPath, 'utf8');
  const violations = findPostCleanupDatabaseErrorSkips(source);
  assert.deepEqual(
    violations,
    [],
    `a failed cleanup must surface instead of reaching a later database-error skip in the same function; violations: ${violations.join(', ')}`
  );
  assert.doesNotMatch(
    source,
    /test\.afterEach\([\s\S]*?try\s*\{[\s\S]*?clearDatabaseRecords\(window\)[\s\S]*?\}\s*catch/,
    'serial-suite teardown must propagate cleanup failures instead of contaminating later cases'
  );
  assert.match(
    source,
    /const teardownErrorText = await window[\s\S]*?expect\(isExpectedDatabaseInitError\(teardownErrorText\)\)\.toBe\(true\);/,
    'teardown may skip cleanup only after re-validating an expected database initialization error'
  );
  const buttonCleanupSource = findNamedFunctionSource(source, 'confirmClearDatabaseAndVerifyEmpty');
  assert.match(
    buttonCleanupSource,
    /await expect\([^)]*\)\.toBeEnabled\(/,
    'the shared button cleanup path must wait for an actionable clear control'
  );
  assert.match(
    buttonCleanupSource,
    /button\[data-variant="destructive"\]:has-text\("Clear"\)/,
    'the shared button cleanup path must keep its broad Clear fallback scoped to the destructive control'
  );
  assert.match(
    buttonCleanupSource,
    /readActiveCollectionRecordTotal\([^)]*\)[\s\S]*?\.toBe\(0\)/,
    'the button cleanup path must verify that the active collection is empty before reporting success'
  );
  assert.match(
    buttonCleanupSource,
    /throw new Error\([^)]*cleanup could not be verified[^)]*\)/i,
    'the shared button cleanup path must throw an observation-bounded verification error'
  );
  for (const callerName of ['executeClearDatabaseWorkflow', 'cleanupExistingData']) {
    const callerSource = findNamedFunctionSource(source, callerName);
    assert.match(
      callerSource,
      /confirmClearDatabaseAndVerifyEmpty\(/,
      `${callerName} must use the shared confirm-and-verify helper`
    );
    assert.doesNotMatch(
      callerSource,
      /role=["']dialog["']/,
      `${callerName} must not re-inline the confirmation dialog flow`
    );
  }
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

    async function cleanupWithAliasedCheck(page: Page) {
      const cleaned = await clearDatabaseRecords(page);
      const hasError = await isDatabaseError(cleaned);
      if (hasError) return cleaned;
      return cleaned;
    }
  `;

  assert.deepEqual(findPostCleanupDatabaseErrorSkips(source), ['11:17', '23:30']);
});
