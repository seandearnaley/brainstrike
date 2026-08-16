import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findLockfileCatalogViolations,
  formatLockfileViolations,
  MIN_CATALOG_IMPORTER_ENTRIES,
} from '../verify-lockfile-catalog-conformance.mjs';

/**
 * Contract for the BST-1324 lockfile/catalog conformance guard.
 *
 * The REAL-TREE test is the live enforcement (Static lane via `pnpm
 * test:scripts`). The fixture tests prove the guard detects the exact outage
 * class that reached main twice on 2026-08-16 (#2483, #2485): an importer
 * entry that says `catalog:` but resolved OUTSIDE the catalog, produced by a
 * textual merge of pnpm-lock.yaml. Per-PR `--frozen-lockfile` cannot catch it
 * by construction — the breakage only exists in the merged result — so this
 * guard is the only automated eye on it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal synthetic workspace + lockfile pair. The default shape is CONFORMANT;
 * each control test breaks exactly one property.
 */
function makeFixture({
  catalogRange = '^10.0.0',
  lockCatalogSpecifier = '^10.0.0',
  lockCatalogVersion = '10.0.0',
  importerVersion = '10.0.0',
  snapshotVersion = '10.0.0',
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lockfile-catalog-guard-'));
  writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    [
      'packages:',
      '  - packages/*',
      'catalogMode: strict',
      'catalog:',
      `  '@stryker-mutator/api': ${catalogRange}`,
      "  typescript: 'npm:@typescript/typescript6@6.0.2'",
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(dir, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      'catalogs:',
      '  default:',
      "    '@stryker-mutator/api':",
      `      specifier: ${lockCatalogSpecifier}`,
      `      version: ${lockCatalogVersion}`,
      '    typescript:',
      '      specifier: npm:@typescript/typescript6@6.0.2',
      '      version: 6.0.2',
      'importers:',
      '  packages/utils:',
      '    devDependencies:',
      "      '@stryker-mutator/api':",
      "        specifier: 'catalog:'",
      `        version: ${importerVersion}`,
      '      typescript:',
      "        specifier: 'catalog:'",
      "        version: '@typescript/typescript6@6.0.2'",
      'packages:',
      `  '@stryker-mutator/api@${snapshotVersion}':`,
      '    resolution: {integrity: sha512-fake}',
      "  '@typescript/typescript6@6.0.2':",
      '    resolution: {integrity: sha512-fake}',
      'snapshots:',
      `  '@stryker-mutator/api@${snapshotVersion}':`,
      '    dependencies: {}',
      "  '@typescript/typescript6@6.0.2':",
      '    dependencies: {}',
      '',
    ].join('\n')
  );
  return dir;
}

test('REAL TREE: every catalog: importer entry conforms to the lockfile catalog block and the workspace catalog', () => {
  const { violations, checkedCount } = findLockfileCatalogViolations(repoRoot);
  assert.deepEqual(
    violations,
    [],
    `pnpm-lock.yaml carries catalog-contradicting entries:\n${formatLockfileViolations(violations)}`
  );
  assert.ok(
    checkedCount >= MIN_CATALOG_IMPORTER_ENTRIES,
    `Only ${checkedCount} catalog: importer entries were checked, below the floor of ` +
      `${MIN_CATALOG_IMPORTER_ENTRIES}. Either the workspace shrank dramatically or discovery ` +
      'broke, in which case the conformance assertion above is vacuously green.'
  );
});

test('CONTROL: the conformant fixture passes', () => {
  const { violations, checkedCount } = findLockfileCatalogViolations(makeFixture(), {
    minEntries: 1,
  });
  assert.deepEqual(violations, []);
  assert.equal(checkedCount, 2);
});

test('CONTROL: detects the #2483/#2485 outage — importer resolved outside the catalog', () => {
  // The exact shape that reached main: catalog pins ^10.0.0, the lockfile's own
  // catalogs block agrees, but a textually merged importer entry still says
  // 9.6.1 from a resolution predating the catalog move.
  const dir = makeFixture({ importerVersion: '9.6.1' });
  const { violations } = findLockfileCatalogViolations(dir, { minEntries: 1 });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /@stryker-mutator\/api/);
  assert.match(violations[0], /9\.6\.1/);
  assert.match(violations[0], /10\.0\.0/);
});

test('CONTROL: detects an importer version whose snapshot is missing', () => {
  // Importer and catalogs block agree on 10.0.0 but no snapshots/packages entry
  // exists for it — the state `--frozen-lockfile` dies on in CI, caught here
  // without an install.
  const dir = makeFixture({
    importerVersion: '11.0.0',
    lockCatalogVersion: '11.0.0',
    snapshotVersion: '10.0.0',
  });
  const { violations } = findLockfileCatalogViolations(dir, { minEntries: 1 });
  assert.ok(violations.length >= 1);
  assert.ok(violations.some((violation) => /snapshot|packages section/i.test(violation)));
});

test('CONTROL: detects lockfile catalogs block drifting from pnpm-workspace.yaml', () => {
  const dir = makeFixture({ lockCatalogSpecifier: '^9.0.0', lockCatalogVersion: '10.0.0' });
  const { violations } = findLockfileCatalogViolations(dir, { minEntries: 1 });
  assert.ok(violations.length >= 1);
  assert.ok(violations.some((violation) => /pnpm-workspace\.yaml/.test(violation)));
});

test('CONTROL: an importer catalog: entry with no catalogs-block entry at all is a violation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lockfile-catalog-guard-'));
  writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - packages/*\ncatalog:\n  '@stryker-mutator/api': ^10.0.0\n"
  );
  writeFileSync(
    path.join(dir, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  packages/utils:',
      '    devDependencies:',
      "      '@stryker-mutator/api':",
      "        specifier: 'catalog:'",
      '        version: 9.6.1',
      '',
    ].join('\n')
  );
  const { violations } = findLockfileCatalogViolations(dir, { minEntries: 1 });
  assert.ok(violations.length >= 1);
  assert.ok(violations.some((violation) => /catalogs block/i.test(violation)));
});
