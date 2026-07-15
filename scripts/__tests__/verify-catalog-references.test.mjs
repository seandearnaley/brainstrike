import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_CHECKED_FIELDS,
  CATALOG_EXEMPT_FIELDS,
  findCatalogViolations,
  formatViolations,
  MIN_CATALOG_ENTRIES,
  MIN_PACKAGE_MANIFESTS,
  packageManifestPaths,
  readCatalogEntries,
} from '../verify-catalog-references.mjs';

/**
 * Contract for the Series C R8 catalog guard. The REAL-TREE test is the live
 * enforcement; the fixture tests below prove the guard actually detects the
 * things it claims to (a guard whose failure path is never exercised is a guard
 * you are trusting on faith).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Build a synthetic workspace. `catalog` entries and per-package manifests are
 * written out so the guard can be pointed at a tree whose drift is deliberate.
 */
function makeFixture({ catalog, packages, extraYaml = '' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'catalog-guard-'));
  const catalogLines = Object.entries(catalog)
    .map(([name, version]) => `  '${name}': ${version}`)
    .join('\n');
  writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    `packages:\n  - packages/*\ncatalogMode: strict\ncatalog:\n${catalogLines}\n${extraYaml}`
  );
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-root' }, null, 2));
  mkdirSync(path.join(dir, 'packages'));
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(path.join(dir, 'packages', name));
    writeFileSync(
      path.join(dir, 'packages', name, 'package.json'),
      JSON.stringify({ name, ...manifest }, null, 2)
    );
  }
  return dir;
}

/** A catalog big enough to clear MIN_CATALOG_ENTRIES, plus filler packages. */
function bulkCatalog(overrides = {}) {
  const catalog = { ...overrides };
  while (Object.keys(catalog).length < MIN_CATALOG_ENTRIES) {
    catalog[`filler-dep-${Object.keys(catalog).length}`] = '^1.0.0';
  }
  return catalog;
}

function bulkPackages(real = {}) {
  const packages = { ...real };
  let i = 0;
  while (Object.keys(packages).length < MIN_PACKAGE_MANIFESTS) {
    packages[`filler-pkg-${i}`] = {};
    i += 1;
  }
  return packages;
}

test('the real repo tree passes: every catalogued dep is referenced as catalog:', () => {
  const violations = findCatalogViolations({ repoRoot });
  assert.deepEqual(
    violations,
    [],
    `Catalogued dependencies referenced by literal version:\n${formatViolations(violations)}`
  );
});

test('MONEY TEST: a hand-edited literal for a catalogued dep FAILS the guard', () => {
  // This reproduces the exact drift that `pnpm install` accepts silently (it
  // resolves a second parallel version into the lockfile and exits 0). The guard
  // is the thing that catches it.
  const catalog = bulkCatalog({ react: '^19.2.7', typescript: '^6.0.3' });
  const dir = makeFixture({
    catalog,
    packages: bulkPackages({
      clean: { devDependencies: { typescript: 'catalog:' } },
      drifted: { devDependencies: { typescript: '^5.9.0' } },
    }),
  });
  try {
    const violations = findCatalogViolations({ repoRoot: dir });
    assert.equal(violations.length, 1, 'expected exactly the one drifted dep to be flagged');
    assert.equal(violations[0].name, 'typescript');
    assert.equal(violations[0].spec, '^5.9.0');
    assert.equal(violations[0].catalogVersion, '^6.0.3');
    assert.equal(violations[0].manifest, path.join('packages', 'drifted', 'package.json'));
    assert.match(formatViolations(violations), /packages[/\\]drifted[/\\]package\.json/);
    assert.match(formatViolations(violations), /typescript/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('RULE: peerDependencies keep literal broad floors and are NOT flagged', () => {
  // The repo-wide split is deliberate: peer = broad floor (^19.2.4, matching
  // `overrides`), dependencies = exact pin (^19.2.7). Catalogging the peer range
  // would silently widen the published contract. Encoded as a rule, not luck.
  const dir = makeFixture({
    catalog: bulkCatalog({ react: '^19.2.7' }),
    packages: bulkPackages({
      lib: {
        devDependencies: { react: 'catalog:' },
        peerDependencies: { react: '^19.2.4' },
      },
    }),
  });
  try {
    assert.deepEqual(findCatalogViolations({ repoRoot: dir }), []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
  assert.ok(
    CATALOG_EXEMPT_FIELDS.includes('peerDependencies'),
    'peerDependencies must stay on the documented exempt list'
  );
  assert.ok(
    !CATALOG_CHECKED_FIELDS.includes('peerDependencies'),
    'peerDependencies must never be added to the checked fields'
  );
});

test('BLIND SPOT: every checked field is actually checked (not just dependencies)', () => {
  for (const field of CATALOG_CHECKED_FIELDS) {
    const dir = makeFixture({
      catalog: bulkCatalog({ vitest: '^4.1.9' }),
      packages: bulkPackages({ drifted: { [field]: { vitest: '^3.0.0' } } }),
    });
    try {
      const violations = findCatalogViolations({ repoRoot: dir });
      assert.equal(violations.length, 1, `${field} drift was not detected`);
      assert.equal(violations[0].field, field);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test('BLIND SPOT: a non-catalogued dep may hold any literal version', () => {
  const dir = makeFixture({
    catalog: bulkCatalog({ typescript: '^6.0.3' }),
    packages: bulkPackages({ lib: { dependencies: { 'not-catalogued': '^1.2.3' } } }),
  });
  try {
    assert.deepEqual(findCatalogViolations({ repoRoot: dir }), []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('BLIND SPOT: catalog:default is accepted; a named catalog: ref is flagged', () => {
  const dir = makeFixture({
    catalog: bulkCatalog({ typescript: '^6.0.3' }),
    packages: bulkPackages({
      explicit: { devDependencies: { typescript: 'catalog:default' } },
      named: { devDependencies: { typescript: 'catalog:legacy' } },
    }),
  });
  try {
    const violations = findCatalogViolations({ repoRoot: dir });
    assert.equal(violations.length, 1, 'catalog:default must pass, catalog:<named> must not');
    assert.equal(violations[0].spec, 'catalog:legacy');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('VACUOUS PASS: an empty/unparsed catalog THROWS instead of reporting success', () => {
  const dir = makeFixture({
    catalog: { typescript: '^6.0.3' }, // 1 entry — far below the floor
    packages: bulkPackages({ drifted: { devDependencies: { typescript: '^5.9.0' } } }),
  });
  try {
    assert.throws(
      () => findCatalogViolations({ repoRoot: dir }),
      /Refusing to run.*below the floor of 10/s,
      'a near-empty catalog must throw, not scan nothing and pass'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('VACUOUS PASS: a near-empty package enumeration THROWS instead of reporting success', () => {
  const dir = makeFixture({
    catalog: bulkCatalog({ typescript: '^6.0.3' }),
    packages: { only: {} }, // 2 manifests (root + one) — below the floor
  });
  try {
    assert.throws(
      () => findCatalogViolations({ repoRoot: dir }),
      /Refusing to run.*below the floor of 30/s,
      'a near-empty manifest enumeration must throw, not iterate zero times and pass'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('NO SILENT FALLBACK: an unparseable package.json THROWS', () => {
  const dir = makeFixture({
    catalog: bulkCatalog({ typescript: '^6.0.3' }),
    packages: bulkPackages(),
  });
  writeFileSync(path.join(dir, 'packages', 'filler-pkg-0', 'package.json'), '{ not json');
  try {
    assert.throws(
      () => findCatalogViolations({ repoRoot: dir }),
      /could not parse/,
      'an unparseable manifest is an unknown state, not a clean one'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('NO SILENT FALLBACK: an unparseable catalog line THROWS', () => {
  const dir = makeFixture({ catalog: bulkCatalog(), packages: bulkPackages() });
  const yamlPath = path.join(dir, 'pnpm-workspace.yaml');
  writeFileSync(
    yamlPath,
    'packages:\n  - packages/*\ncatalog:\n  react: ^19.2.7\n  {weird: shape}\n'
  );
  try {
    assert.throws(
      () => readCatalogEntries(dir),
      /could not parse this line/,
      'an unparseable catalog line would drop a name from the checked set'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('NO SILENT FALLBACK: a named-catalog block (catalogs:) THROWS as unmodelled', () => {
  const dir = makeFixture({
    catalog: bulkCatalog(),
    extraYaml: 'catalogs:\n  legacy:\n    react: ^18.0.0\n',
    packages: bulkPackages(),
  });
  try {
    assert.throws(
      () => readCatalogEntries(dir),
      /named-catalog block/,
      'names inside an unmodelled named catalog would silently escape the guard'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('the real catalog and enumeration clear their floors with headroom', () => {
  const catalog = readCatalogEntries(repoRoot);
  const manifests = packageManifestPaths(repoRoot);
  assert.ok(
    catalog.size >= MIN_CATALOG_ENTRIES,
    `real catalog has ${catalog.size} entries, floor is ${MIN_CATALOG_ENTRIES}`
  );
  assert.ok(
    manifests.length >= MIN_PACKAGE_MANIFESTS,
    `real enumeration found ${manifests.length} manifests, floor is ${MIN_PACKAGE_MANIFESTS}`
  );
  // The root manifest declares catalogued devDeps too — it must be governed.
  assert.ok(
    manifests.includes(path.join(repoRoot, 'package.json')),
    'the workspace root package.json must be governed by this guard'
  );
});
