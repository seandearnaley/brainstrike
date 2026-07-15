import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bareOverrideTarget,
  CATALOG_CHECKED_FIELDS,
  CATALOG_EXEMPT_FIELDS,
  findCatalogOverrideConflicts,
  findCatalogViolations,
  formatViolations,
  MIN_CATALOG_ENTRIES,
  MIN_PACKAGE_MANIFESTS,
  packageManifestPaths,
  readCatalogEntries,
  readOverrideKeys,
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

test('NO SILENT FALLBACK: an unparseable overrides line THROWS', () => {
  // The twin of the catalog-parser hole. The line-shape regex alone accepts
  // `{weird: shape}` as the key "{weird"; a bogus key yields a bogus conflict
  // verdict, letting the catalog-shadowing defect hide behind malformed YAML.
  // Before the fix this returned ['react', '{weird'] silently.
  const dir = makeFixture({ catalog: bulkCatalog(), packages: bulkPackages() });
  writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\noverrides:\n  react: ^19.2.4\n  {weird: shape}\n'
  );
  try {
    assert.throws(
      () => readOverrideKeys(dir),
      /not a valid npm package name/,
      'a malformed override key must throw, not be recorded as a bogus package name'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('every real override key survives validation (the 6 classification cases)', () => {
  // Drives the REAL parser, not just bareOverrideTarget() in isolation: proves
  // the new validation admits every legitimate override shape and does not
  // regress the bare-vs-subtree-scoped classification.
  const dir = makeFixture({
    catalog: bulkCatalog({ react: '^19.2.7' }),
    extraYaml:
      'overrides:\n' +
      '  react: ^19.2.4\n' +
      '  "@types/node": ^26.1.0\n' +
      '  react@^19: ^19.2.4\n' +
      '  "@types/node@^26": ^26.1.0\n' +
      '  react-helmet-async>react: ^19.0.0\n' +
      '  foo@1.0.0>bar: ^2.0.0\n',
    packages: bulkPackages(),
  });
  try {
    assert.deepEqual(readOverrideKeys(dir), [
      'react',
      '@types/node',
      'react@^19',
      '@types/node@^26',
      'react-helmet-async>react',
      'foo@1.0.0>bar',
    ]);
    // Only the three BARE keys targeting react shadow it; the subtree-scoped
    // ones must not produce a conflict.
    const conflicts = findCatalogOverrideConflicts({ repoRoot: dir });
    assert.deepEqual(
      conflicts.map((c) => c.overrideKey),
      ['react', 'react@^19'],
      'bare react keys conflict; @types/node is not catalogued here; a>b keys never conflict'
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

test('the real repo tree has no catalogued dep shadowed by a bare override', () => {
  // A bare override SHADOWS a catalog entry: measured live — with
  // `overrides: react: ^19.2.4`, a `catalog: react: ^19.9.9` (nonexistent
  // version) still installs clean and resolves 19.2.7, and the lockfile's
  // `catalogs: default:` block omits react entirely. Such an entry is inert,
  // unvalidated, and rots silently when the override is bumped.
  const conflicts = findCatalogOverrideConflicts({ repoRoot });
  assert.deepEqual(
    conflicts,
    [],
    'These catalogued deps are silently shadowed by a bare overrides: entry, so their catalog value governs ' +
      `NOTHING:\n${conflicts
        .map(
          (c) =>
            `  ${c.name}: catalog says "${c.catalogVersion}" but overrides["${c.overrideKey}"] wins. ` +
            'Either drop it from the catalog (leaving overrides the single governor — correct when the override ' +
            'is load-bearing for TRANSITIVE deps, as with react/react-dom) or remove the override so the catalog ' +
            'genuinely governs. Do not keep both: the catalog entry would be decorative.'
        )
        .join('\n')}`
  );
});

test('RULE: only BARE override keys shadow; subtree-scoped (parent>child) do not', () => {
  // `@` is NOT a scoping signal — it appears in ordinary bare keys as an npm
  // scope (@types/node) and as a version selector (react@^19). Only `>` scopes.
  assert.equal(bareOverrideTarget('react'), 'react');
  assert.equal(bareOverrideTarget('@types/node'), '@types/node');
  assert.equal(bareOverrideTarget('react@^19'), 'react');
  assert.equal(bareOverrideTarget('@types/node@^26'), '@types/node');
  assert.equal(bareOverrideTarget('react-helmet-async>react'), null);
  assert.equal(bareOverrideTarget('foo@1.0.0>bar'), null);
});

test('the real overrides block still carries the load-bearing react pins', () => {
  // Guards the (a)-decision itself: react/react-dom are governed by overrides
  // ALONE. If someone deletes these, react silently loses its single-instance
  // guarantee across the 157 third-party packages that depend on it directly —
  // a catalog cannot replace this, it has no transitive scope.
  const keys = readOverrideKeys(repoRoot);
  for (const required of ['react', 'react-dom']) {
    assert.ok(
      keys.includes(required),
      `pnpm-workspace.yaml overrides must keep the bare "${required}" pin: it is the SINGLE governor for ` +
        `${required} (deliberately not catalogued) and the only mechanism with transitive scope. Removing it ` +
        'would let third-party packages resolve their own react and reintroduce multi-instance React bugs.'
    );
  }
  const catalog = readCatalogEntries(repoRoot);
  for (const excluded of ['react', 'react-dom']) {
    assert.ok(
      !catalog.has(excluded),
      `${excluded} must NOT be catalogued: the bare override shadows it, making the catalog value inert and ` +
        'free to rot. See the note in pnpm-workspace.yaml.'
    );
  }
});

test('BLIND SPOT: a catalog entry shadowed by a bare override IS detected', () => {
  const dir = makeFixture({
    catalog: bulkCatalog({ react: '^19.2.7' }),
    extraYaml: 'overrides:\n  react: ^19.2.4\n  react-helmet-async>react: ^19.0.0\n',
    packages: bulkPackages(),
  });
  try {
    const conflicts = findCatalogOverrideConflicts({ repoRoot: dir });
    assert.equal(conflicts.length, 1, 'the bare override must conflict; the scoped one must not');
    assert.equal(conflicts[0].name, 'react');
    assert.equal(conflicts[0].overrideKey, 'react');
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
