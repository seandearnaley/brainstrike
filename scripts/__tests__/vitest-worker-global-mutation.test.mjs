import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findVitestWorkerMutations,
  scanRepositoryTestFiles,
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
