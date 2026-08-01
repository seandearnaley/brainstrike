import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbRoot = path.join(repoRoot, 'packages/db');
const testsRoot = path.join(dbRoot, '__tests__');
const configSource = readFileSync(path.join(dbRoot, 'vitest.config.mts'), 'utf8');
const MINIMUM_DB_UNIT_TEST_FILES = 150;

function collectTestFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (/\.test\.(ts|tsx)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function assertDbUnitDiscovery(source, allTestFiles) {
  assert.match(
    source,
    /include:\s*\[\s*['"]__tests__\/\*\*\/\*\.test\.\{ts,tsx\}['"]\s*\]/u,
    'DB unit discovery must keep the recursive __tests__/**/*.test.{ts,tsx} include'
  );
  assert.match(
    source,
    /exclude:\s*\[[^\]]*['"]\*\*\/\*\.browser\.test\.\{ts,tsx\}['"][^\]]*\]/u,
    'DB unit discovery must keep browser-only specs out of the node unit project'
  );

  const unitFiles = allTestFiles.filter((file) => !file.includes('.browser.test.'));
  assert.ok(
    unitFiles.length >= MINIMUM_DB_UNIT_TEST_FILES,
    `expected at least ${MINIMUM_DB_UNIT_TEST_FILES} DB unit test files; found ${unitFiles.length}`
  );
  assert.ok(
    unitFiles.some((file) => file.includes('/')),
    'expected at least one nested DB unit test; a non-recursive sweep would be vacuous'
  );
  assert.ok(
    allTestFiles.some((file) => file.includes('.browser.test.')),
    'expected at least one browser-only DB spec to keep the unit exclude load-bearing'
  );
}

const allTestFiles = collectTestFiles(testsRoot);

test('DB unit tests are discovered recursively without a registration manifest', () => {
  assertDbUnitDiscovery(configSource, allTestFiles);
});

test('money test: narrowing the recursive include fails the discovery contract', () => {
  const narrowed = configSource.replace(
    '__tests__/**/*.test.{ts,tsx}',
    '__tests__/*.test.{ts,tsx}'
  );
  assert.notEqual(narrowed, configSource, 'the include control mutation must match real config');
  assert.throws(() => assertDbUnitDiscovery(narrowed, allTestFiles), /recursive __tests__/);
});

test('money test: collapsing the discovered file set below its floor fails', () => {
  assert.throws(
    () => assertDbUnitDiscovery(configSource, allTestFiles.slice(0, 10)),
    /expected at least 150 DB unit test files; found 10/
  );
});

test('money test: dropping the browser exclusion fails loudly', () => {
  const unexcluded = configSource.replace(
    '**/*.browser.test.{ts,tsx}',
    '**/*.browser-spec.test.{ts,tsx}'
  );
  assert.notEqual(unexcluded, configSource, 'the browser-exclude control must match real config');
  assert.throws(() => assertDbUnitDiscovery(unexcluded, allTestFiles), /browser-only specs/);
});
