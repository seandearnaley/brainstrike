import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
function parse(source) {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, 'Telemetry guard requires valid TypeScript');
  return file;
}
function descendants(node, predicate) {
  const found = [];
  function visit(child) {
    if (predicate(child)) {
      found.push(child);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
function scope(source, name) {
  const matches = descendants(
    parse(source),
    (node) =>
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name?.getText() === name
  );
  assert.equal(matches.length, 1, `Expected exactly one ${name}`);
  return matches[0];
}
function expressionName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionName(node.expression)}.${node.name.text}`;
  }
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this';
  }
  return;
}
function calls(node, name) {
  return descendants(
    node,
    (child) => ts.isCallExpression(child) && expressionName(child.expression) === name
  );
}
function assertMeasured(scopeNode, operation, wrapper, feature) {
  const operations = calls(scopeNode, operation);
  assert.ok(operations.length > 0, `Missing operation ${operation}`);
  for (const call of operations) {
    let measured = false;
    for (let ancestor = call.parent; ancestor; ancestor = ancestor.parent) {
      if (!(ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor))) {
        continue;
      }
      const parent = ancestor.parent;
      if (!ts.isCallExpression(parent) || expressionName(parent.expression) !== wrapper) {
        continue;
      }
      const callbackIndex = feature === undefined ? 0 : 1;
      if (parent.arguments[callbackIndex] !== ancestor) {
        continue;
      }
      if (
        feature !== undefined &&
        (!ts.isStringLiteral(parent.arguments[0]) || parent.arguments[0].text !== feature)
      ) {
        continue;
      }
      measured = true;
      break;
    }
    assert.ok(
      measured,
      `${operation} outside measured callback ${wrapper}(${feature ?? 'callback'})`
    );
  }
}

const basePath = 'packages/db/src/repositories/base-repository.ts';
const drizzlePath = 'packages/db/src/repositories/drizzle/file-record-repository.ts';
const readMethods = [
  'count',
  'countWithContent',
  'findAll',
  'findAllWithContent',
  'findByContentHash',
  'findById',
  'findByIds',
  'findByManagedCacheIdentity',
  'listManagedCacheEntries',
  'listManagedCacheEntryMetadata',
];
const writeMethods = [
  'bulkImport',
  'clearAll',
  'create',
  'createWithContent',
  'delete',
  'update',
  'updateContent',
  'updateStatMetadata',
];

describe('database telemetry seams', () => {
  it('classifies every declared file-record method, so new reads require a decision', () => {
    const declared = scope(
      read('packages/db/src/repositories/interfaces.ts'),
      'IFileRecordRepository'
    )
      .members.map((member) => member.name.getText())
      .sort();
    assert.deepEqual(declared, [...readMethods, ...writeMethods].sort());
  });
  for (const [path, operation] of [
    [basePath, 'this.db.query'],
    [drizzlePath, 'this.db.select'],
  ]) {
    it(`measures every file-record read in ${path}`, () => {
      const source = read(path);
      const className =
        path === basePath ? 'BaseFileRecordRepository' : 'DrizzleFileRecordRepository';
      const publicMethods = scope(source, className)
        .members.filter(
          (member) =>
            ts.isMethodDeclaration(member) &&
            !member.modifiers?.some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.PrivateKeyword ||
                modifier.kind === ts.SyntaxKind.ProtectedKeyword
            )
        )
        .map((member) => member.name.getText())
        .sort();
      assert.deepEqual(
        publicMethods,
        [
          ...readMethods,
          ...writeMethods,
          ...(path === drizzlePath ? ['findByNameSubstring'] : []),
        ].sort(),
        `${className}: classify every public method`
      );

      const methods = path === drizzlePath ? [...readMethods, 'findByNameSubstring'] : readMethods;
      for (const method of methods) {
        assertMeasured(scope(source, method), operation, 'measureDatabaseQuery', 'file-tree');
      }
    });
  }
  it('measures token-cache aggregate reads through the injected telemetry port', () => {
    assertMeasured(
      scope(read('packages/token-cache/src/token-cache-store.ts'), 'getTotalTokens'),
      'this.db.query',
      'this.measureLookup'
    );
  });
  it('measures live-query creation and refresh at the scheduler owner', () => {
    const source = read('packages/db/src/database-work-scheduler.ts');
    assertMeasured(
      scope(source, 'createScheduledLiveNamespace'),
      'Reflect.apply',
      'measureDatabaseQuery',
      'live-query'
    );
    const handle = scope(source, 'createScheduledLiveQueryHandle');
    // Subscribe/unsubscribe Reflect.apply calls have lifecycle counters instead.
    const refresh = calls(handle, 'Reflect.apply').filter((call) =>
      call.arguments[0].getText().startsWith('refresh ')
    );
    assert.equal(refresh.length, 1);
    assertMeasured(refresh[0], 'Reflect.apply', 'measureDatabaseQuery', 'live-query');
    for (const counter of [
      'recordDatabaseLiveSubscriptionStarted',
      'recordDatabaseLiveSubscriptionEnded',
      'recordDatabaseLiveUpdate',
    ]) {
      assert.equal(calls(handle, counter).length, 1, counter);
    }
  });
  it('measures Electron live-query start and refresh separately', () => {
    const owner = scope(read('packages/db/src/use-live-query.ts'), 'subscribeViaElectron');
    for (const operation of ['bridge.start', 'bridge.refresh']) {
      assertMeasured(owner, operation, 'measureDatabaseQuery', 'live-query');
    }
    for (const counter of [
      'recordDatabaseLiveSubscriptionStarted',
      'recordDatabaseLiveSubscriptionEnded',
      'recordDatabaseLiveUpdate',
    ]) {
      assert.equal(calls(owner, counter).length, 1, counter);
    }
  });
});

describe('telemetry guard negative controls', () => {
  const fixture = (body) => scope(`async function readRows() { ${body} }`, 'readRows');
  it('accepts an operation inside the measured callback', () => {
    assertMeasured(
      fixture("return measureDatabaseQuery('file-tree', async () => this.db.query('SELECT 1'));"),
      'this.db.query',
      'measureDatabaseQuery',
      'file-tree'
    );
  });
  for (const body of [
    "return this.db.query('SELECT 1');",
    "return measureDatabaseQuery('queue-stats', async () => this.db.query('SELECT 1'));",
    "await this.db.query('SELECT 1'); return measureDatabaseQuery('file-tree', async () => []);",
    "// measureDatabaseQuery('file-tree', async () => this.db.query('SELECT 1'))\nreturn this.db.query('SELECT 1');",
    "return measureDatabaseQuery('file-tree', this.db.query('SELECT 1'));",
  ]) {
    it(`rejects unmeasured work: ${body}`, () => {
      assert.throws(
        () => assertMeasured(fixture(body), 'this.db.query', 'measureDatabaseQuery', 'file-tree'),
        /outside measured callback/
      );
    });
  }
  it('fails loudly if the expected operation disappeared', () => {
    assert.throws(
      () =>
        assertMeasured(fixture('return [];'), 'this.db.query', 'measureDatabaseQuery', 'file-tree'),
      /Missing operation/
    );
  });
});
