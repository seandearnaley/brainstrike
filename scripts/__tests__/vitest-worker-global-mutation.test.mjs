import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findVitestWorkerMutations,
  scanRepositoryTestFiles,
  stripComments,
} from '../verify-no-vitest-worker-mutation.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('flags the original withClearedTestMarkers deletion pattern', () => {
  const source = `
const globalRecord = globalThis as Record<string, unknown>;
Reflect.deleteProperty(globalRecord, '__vitest_worker__');
`;
  const violations = findVitestWorkerMutations(source, 'example.test.ts');
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /deleteProperty/);
});

test('flags delete expressions and restoring assignments', () => {
  const source = `
delete (globalThis as Record<string, unknown>)['__vitest_worker__'];
globalRecord['__vitest_worker__'] = originalWorker;
`;
  const descriptions = findVitestWorkerMutations(source, 'example.test.ts').map(
    (violation) => violation.description
  );
  assert.equal(descriptions.length, 2);
  assert.ok(descriptions.some((description) => description.includes('delete')));
  assert.ok(descriptions.some((description) => description.includes('assignment')));
});

test('flags vi.stubGlobal of the worker state key', () => {
  const source = `vi.stubGlobal('__vitest_worker__', undefined);`;
  const violations = findVitestWorkerMutations(source, 'example.test.ts');
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /stubGlobal/);
});

test('allows reads, `in` probes, and plain-object literal keys', () => {
  const source = `
const isTest = '__vitest_worker__' in globalThis;
expect(detectTestEnvironment({ __vitest_worker__: {} })).toBe(true);
const snapshot = globalRecord['__vitest_worker__'];
if (snapshot === undefined) {}
const arrow = () => '__vitest_worker__';
`;
  assert.deepEqual(findVitestWorkerMutations(source, 'example.test.ts'), []);
});

test('flags Reflect.set and Object.assign mutation forms', () => {
  const source = `
Reflect.set(globalThis, '__vitest_worker__', undefined);
Object.assign(globalThis, { __vitest_worker__: undefined });
`;
  const descriptions = findVitestWorkerMutations(source, 'example.test.ts').map(
    (violation) => violation.description
  );
  assert.equal(descriptions.length, 2);
  assert.ok(descriptions.some((description) => description.includes('Reflect.set')));
  assert.ok(descriptions.some((description) => description.includes('Object.assign')));
});

test('flags logical-assignment operators', () => {
  for (const operator of ['??=', '||=', '&&=']) {
    const source = `globalThis.__vitest_worker__ ${operator} fake;`;
    const violations = findVitestWorkerMutations(source, 'example.test.ts');
    assert.equal(violations.length, 1, `expected ${operator} to be flagged`);
    assert.match(violations[0].description, /assignment/);
  }
});

test('does not flag comments mentioning mutation of the key', () => {
  const source = `
// never delete the __vitest_worker__ global from tests
/* legacy approach: delete globalThis['__vitest_worker__'] — banned */
const stillFine = '__vitest_worker__' in globalThis;
`;
  assert.deepEqual(findVitestWorkerMutations(source, 'example.test.ts'), []);
});

test('stripComments keeps URLs in strings intact', () => {
  const source = `const docs = 'https://vitest.dev/guide'; // delete __vitest_worker__ note`;
  const stripped = stripComments(source);
  assert.ok(stripped.includes('https://vitest.dev/guide'));
  assert.ok(!stripped.includes('note'));
});

test('no test file in packages/ or apps/ mutates __vitest_worker__', () => {
  const violations = scanRepositoryTestFiles(repoRoot);
  assert.deepEqual(
    violations,
    [],
    'Test files must not delete/reassign the __vitest_worker__ global (BST-591 flake class). ' +
      'Use a mockable detection seam instead, e.g. packages/file-explorer/src/persistence/test-environment.ts. ' +
      `Violations: ${JSON.stringify(violations, null, 2)}`
  );
});
