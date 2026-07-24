import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyDeclarationOwner,
  classifyFieldValue,
  discoverTsupPackages,
  findGuardedFieldOccurrences,
  findTsupInvariantViolations,
  formatTsupViolations,
  GUARDED_FIELDS,
  MIN_TSUP_CONFIGS,
  MIN_TYPESCRIPT_OWNED_PACKAGES,
  readTsupCliFlags,
} from '../verify-tsup-build-invariants.mjs';

/**
 * Contract for the BST-746 tsup build-invariant guard. The REAL-TREE tests are
 * the live enforcement; the fixture tests prove the guard actually rejects the
 * things it claims to. A guard whose failure path is never exercised is a guard
 * you are trusting on faith.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const guardScript = path.join(repoRoot, 'scripts', 'verify-tsup-build-invariants.mjs');

const TSC_BUILD = 'pnpm run clean && tsc -b . && tsup --config ./tsup.config.ts';
const TSUP_ONLY_BUILD = 'tsup --config ./tsup.config.ts';

/** A compliant TypeScript-owned config: both invariants held as literal false. */
function compliantConfig() {
  return "import { defineConfig } from 'tsup';\n\nexport default defineConfig({\n  clean: false,\n  dts: false,\n  entry: ['src/index.ts'],\n});\n";
}

/**
 * Build a synthetic workspace. Each package supplies its `build` script and an
 * optional tsup.config.ts so the guard can be pointed at a tree whose drift is
 * deliberate.
 */
function makeFixture({ packages }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsup-invariant-guard-'));
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-root' }, null, 2));
  mkdirSync(path.join(dir, 'packages'));
  for (const [name, spec] of Object.entries(packages)) {
    const packageDir = path.join(dir, 'packages', name);
    mkdirSync(packageDir);
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name, scripts: { build: spec.build }, ...(spec.manifest ?? {}) }, null, 2)
    );
    if (spec.config !== undefined) {
      writeFileSync(path.join(packageDir, 'tsup.config.ts'), spec.config);
    }
  }
  return dir;
}

/**
 * Enough compliant TypeScript-owned packages to clear BOTH discovery floors.
 *
 * The floors count different things (config FILES vs. TypeScript-owned
 * PACKAGES), so the filler tops up each independently — padding by package count
 * alone leaves a config-less fixture package one config short of the floor.
 */
function withFloorFiller(real = {}) {
  const packages = { ...real };
  const specs = () => Object.values(packages);
  let i = 0;
  while (
    specs().filter((spec) => spec.config !== undefined).length < MIN_TSUP_CONFIGS ||
    specs().filter((spec) => /\btsc\s+(?:-b|--build)\b/.test(spec.build ?? '')).length <
      MIN_TYPESCRIPT_OWNED_PACKAGES
  ) {
    packages[`filler-pkg-${i}`] = { build: TSC_BUILD, config: compliantConfig() };
    i += 1;
  }
  return packages;
}

function runFixture(packages) {
  const dir = makeFixture({ packages });
  try {
    return findTsupInvariantViolations({ repoRoot: dir });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('the real repo tree passes: every tsc -b package pins clean:false/dts:false', () => {
  const violations = findTsupInvariantViolations({ repoRoot });
  assert.deepEqual(
    violations,
    [],
    `tsup build-invariant violations:\n${formatTsupViolations(violations)}`
  );
});

test('the guard script itself exits 0 on the real tree and reports what it inspected', () => {
  // Proves main() is wired up, not just the exported checker — `pnpm lint` runs
  // the script, so an exported-only green would be a green nobody executes.
  const stdout = execFileSync(process.execPath, [guardScript], { encoding: 'utf8' });
  assert.match(stdout, /tsup build invariants hold: \d+ tsup\.config\.ts file\(s\) inspected/);
});

test('MONEY TEST: `clean: true` in a tsc -b package FAILS the guard', () => {
  // The drift that silently deletes the .d.ts files tsc -b just emitted into
  // dist. Nothing else in the build reports it: tsup exits 0 and the package
  // publishes JS with no types.
  const violations = runFixture(
    withFloorFiller({
      drifted: {
        build: TSC_BUILD,
        config: compliantConfig().replace('clean: false', 'clean: true'),
      },
    })
  );
  assert.equal(violations.length, 1, 'expected exactly the one drifted config to be flagged');
  assert.equal(violations[0].field, 'clean');
  assert.equal(violations[0].kind, 'config-true');
  assert.equal(violations[0].packageName, 'drifted');
  assert.match(violations[0].location, /packages[/\\]drifted[/\\]tsup\.config\.ts:4/);
  const report = formatTsupViolations(violations);
  assert.match(report, /unlinks the whole outDir/);
  assert.match(report, /Set `clean: false`/);
});

test('MONEY TEST 2: `dts: true` in a tsc -b package FAILS the guard', () => {
  const violations = runFixture(
    withFloorFiller({
      drifted: { build: TSC_BUILD, config: compliantConfig().replace('dts: false', 'dts: true') },
    })
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'dts');
  assert.equal(violations[0].kind, 'config-true');
  const report = formatTsupViolations(violations);
  assert.match(report, /declaration bundler duplicates/);
  assert.doesNotMatch(report, /unlinks the whole outDir/);
});

test('RULING: `clean: !options.watch` is fine in a tsup-owned package, a violation in a tsc -b one', () => {
  // The documented ruling on dynamic expressions, driven through the real
  // checker in BOTH directions. It is not a false positive today because every
  // config using it builds with tsup alone; the same text in a `tsc -b` package
  // cleans during a plain `pnpm build` and must fail.
  const dynamicClean =
    "import { defineConfig } from 'tsup';\n\nexport default defineConfig((options) => ({\n  clean: !options.watch,\n  dts: true,\n  entry: ['src/index.ts'],\n}));\n";

  assert.deepEqual(
    runFixture(withFloorFiller({ worker: { build: TSUP_ONLY_BUILD, config: dynamicClean } })),
    [],
    '`clean: !options.watch` must not be flagged where tsup is the only writer of dist'
  );

  const violations = runFixture(
    withFloorFiller({
      libraryish: { build: TSC_BUILD, config: dynamicClean.replace('dts: true', 'dts: false') },
    })
  );
  assert.equal(violations.length, 1, 'the same expression must fail once tsc -b owns declarations');
  assert.equal(violations[0].kind, 'config-dynamic');
  assert.equal(violations[0].expression, '!options.watch');
  const report = formatTsupViolations(violations);
  assert.match(report, /cannot prove it evaluates false/);
  assert.match(report, /Write the literal `false`/);
});

test('BLIND SPOT: a dynamic value is rejected outright, not just literal `true`', () => {
  // "Not literally true" is not the same as "false". A ternary that evaluates
  // true would otherwise walk straight through the check.
  for (const expression of ['process.env.CI ? true : false', 'Boolean(process.env.CLEAN)']) {
    const violations = runFixture(
      withFloorFiller({
        drifted: {
          build: TSC_BUILD,
          config: compliantConfig().replace('clean: false', `clean: ${expression}`),
        },
      })
    );
    assert.equal(violations.length, 1, `\`clean: ${expression}\` was not rejected`);
    assert.equal(violations[0].kind, 'config-dynamic');
  }
});

test('BLIND SPOT: every guarded field is actually enforced (not just clean)', () => {
  for (const field of GUARDED_FIELDS) {
    const violations = runFixture(
      withFloorFiller({
        drifted: {
          build: TSC_BUILD,
          config: compliantConfig().replace(`${field}: false`, `${field}: true`),
        },
      })
    );
    assert.equal(violations.length, 1, `${field} drift was not detected`);
    assert.equal(violations[0].field, field);
  }
});

test('BLIND SPOT: a `--dts` CLI flag bypasses the config file and is still caught', () => {
  // tsup reads these flags from the command line too, so a config-file-only
  // guard would leave `tsc -b . && tsup src/index.ts --dts` wide open.
  const violations = runFixture(
    withFloorFiller({
      drifted: { build: 'tsc -b . && tsup src/index.ts --dts', config: compliantConfig() },
    })
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'cli-flag');
  assert.equal(violations[0].field, 'dts');
  assert.match(formatTsupViolations(violations), /Drop the flag from the build script/);
});

test('BLIND SPOT: a tsc -b package with NO tsup.config.ts is still CLI-checked', () => {
  // @brainstrike/queue, @brainstrike/types and @brainstrike/worker-runtime build
  // this way on the real tree — config-file discovery alone would skip them.
  const violations = runFixture(
    withFloorFiller({
      configless: { build: 'pnpm run clean && tsc -b . && tsup src/index.ts --clean' },
    })
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'cli-flag');
  assert.equal(violations[0].field, 'clean');
});

test('RULE: `pnpm run clean && tsc -b . && tsup` is NOT read as a tsup --clean', () => {
  // Only segments that invoke tsup may contribute flags; a sibling `clean`
  // script in the chain is an ordered, deliberate step outside tsup.
  assert.deepEqual(readTsupCliFlags(TSC_BUILD), { clean: false, dts: false });
  assert.deepEqual(readTsupCliFlags('pnpm run clean && tsc -b . && tsup'), {
    clean: false,
    dts: false,
  });
  assert.deepEqual(readTsupCliFlags('tsc -b . && tsup src/index.ts --dts --clean'), {
    clean: true,
    dts: true,
  });
});

test('EXEMPTION IS LOAD-BEARING: a tsup-owned package that emits no declarations FAILS', () => {
  // The tsup-owned class must not become a place to park a config to silence the
  // guard. With no `tsc -b` and `dts: false`, nothing emits .d.ts at all.
  const violations = runFixture(
    withFloorFiller({
      worker: { build: TSUP_ONLY_BUILD, config: compliantConfig() },
    })
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'tsup-owned-without-dts');
  const report = formatTsupViolations(violations);
  assert.match(report, /would publish no \.d\.ts at all/);
  // …and a `--dts` on the build script satisfies the obligation without a config.
  assert.deepEqual(
    runFixture(
      withFloorFiller({
        worker: { build: 'tsup src/index.ts --dts', config: compliantConfig() },
      })
    ),
    []
  );
});

test('VACUOUS PASS: too few discovered configs THROWS instead of reporting success', () => {
  const dir = makeFixture({
    packages: { only: { build: TSC_BUILD, config: compliantConfig() } },
  });
  try {
    assert.throws(
      () => findTsupInvariantViolations({ repoRoot: dir }),
      new RegExp(`Refusing to run.*below the floor of ${MIN_TSUP_CONFIGS}`, 's'),
      'a near-empty scan must throw, not inspect nothing and pass'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('VACUOUS PASS: a collapsed classification THROWS even with every config found', () => {
  // The subtle vacuous green: discovery is healthy, but classifyDeclarationOwner
  // stops recognising `tsc -b`, so the class the invariants govern empties out
  // and the guard checks nothing while looking busy.
  const packages = {};
  for (let i = 0; i < MIN_TSUP_CONFIGS + 2; i += 1) {
    packages[`worker-${i}`] = {
      build: TSUP_ONLY_BUILD,
      config: compliantConfig().replace('dts: false', 'dts: true'),
    };
  }
  const dir = makeFixture({ packages });
  try {
    assert.throws(
      () => findTsupInvariantViolations({ repoRoot: dir }),
      new RegExp(
        `classified as TypeScript-owned, below the floor of ${MIN_TYPESCRIPT_OWNED_PACKAGES}`,
        's'
      ),
      'an empty governed class must throw, not enumerate configs and check none'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('NO SILENT FALLBACK: a `clean:` written in an unmodelled shape THROWS', () => {
  // The line shape is what the repo writes today; anything else must fail loudly
  // rather than be silently skipped. An unparsed `clean: true` is precisely the
  // drift this guard exists to catch.
  assert.throws(
    () => findGuardedFieldOccurrences('export default { entry: [], clean: true };\n', 'fixture.ts'),
    /could only parse 0 of them/,
    'a property inlined after `{` must not slip through unparsed'
  );
  assert.throws(
    () => findGuardedFieldOccurrences('export default {\n  clean:\n    true,\n};\n', 'fixture.ts'),
    /shape this guard does not model/,
    'a multi-line value must not slip through unparsed'
  );
});

test('NO SILENT FALLBACK: a duplicated clean/dts assignment THROWS', () => {
  assert.throws(
    () =>
      findGuardedFieldOccurrences(
        'export default {\n  clean: false,\n  dts: false,\n  clean: true,\n};\n',
        'fixture.ts'
      ),
    /more than one `clean:` assignment/,
    'the effective value would depend on literal ordering, which this guard does not model'
  );
});

test('NO SILENT FALLBACK: a package.json `tsup` config block THROWS as unmodelled', () => {
  const dir = makeFixture({
    packages: withFloorFiller({
      inline: { build: TSC_BUILD, manifest: { tsup: { clean: true, dts: true } } },
    }),
  });
  try {
    assert.throws(
      () => findTsupInvariantViolations({ repoRoot: dir }),
      /package\.json `tsup` config block/,
      'settings inside a package.json tsup block would escape a config-file scan entirely'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('NO SILENT FALLBACK: an unparseable package.json THROWS', () => {
  const dir = makeFixture({ packages: withFloorFiller() });
  writeFileSync(path.join(dir, 'packages', 'filler-pkg-0', 'package.json'), '{ not json');
  try {
    assert.throws(
      () => findTsupInvariantViolations({ repoRoot: dir }),
      /could not parse/,
      'an unparseable manifest is an unknown state, not a clean one'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('BLIND SPOT: a package that never invokes tsup is not inspected at all', () => {
  const dir = makeFixture({
    packages: withFloorFiller({ 'not-tsup': { build: 'tsc -b .' } }),
  });
  try {
    assert.deepEqual(findTsupInvariantViolations({ repoRoot: dir }), []);
    assert.ok(
      !discoverTsupPackages(dir).some((pkg) => pkg.name === 'not-tsup'),
      'a package with neither a tsup config nor a tsup invocation must not be discovered'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('RULE: declaration ownership is read off the build script, both tsc spellings', () => {
  assert.equal(classifyDeclarationOwner('tsc -b . && tsup'), 'typescript');
  assert.equal(classifyDeclarationOwner('tsc --build && tsup'), 'typescript');
  assert.equal(classifyDeclarationOwner('pnpm run clean && tsc -b . && tsup'), 'typescript');
  assert.equal(classifyDeclarationOwner('tsup --config ./tsup.config.ts'), 'tsup');
  // `tsc --noEmit` is a type-check, NOT a declaration emit — it must not
  // misclassify a worker package into the governed class.
  assert.equal(classifyDeclarationOwner('tsc --noEmit && tsup'), 'tsup');
  assert.equal(classifyDeclarationOwner(undefined), 'tsup');
});

test('RULE: only the literal `false` counts as compliant', () => {
  assert.equal(classifyFieldValue('false'), 'false');
  assert.equal(classifyFieldValue('true'), 'true');
  assert.equal(classifyFieldValue('!options.watch'), 'dynamic');
  assert.equal(classifyFieldValue('options.watch ? false : false'), 'dynamic');
});

test('the real tree clears both floors with headroom, and the tsup-owned set is pinned', () => {
  const packages = discoverTsupPackages(repoRoot);
  const configs = packages.filter((pkg) => pkg.configSource !== null);
  const owned = packages.filter((pkg) => pkg.declarationOwner === 'typescript');
  assert.ok(
    configs.length >= MIN_TSUP_CONFIGS,
    `real tree has ${configs.length} tsup configs, floor is ${MIN_TSUP_CONFIGS}`
  );
  assert.ok(
    owned.length >= MIN_TYPESCRIPT_OWNED_PACKAGES,
    `real tree has ${owned.length} TypeScript-owned packages, floor is ${MIN_TYPESCRIPT_OWNED_PACKAGES}`
  );
  // Pinned, not merely observed: these four are the ONLY packages exempt from the
  // clean/dts invariants, because they are the only ones with no `tsc -b` step.
  // Growing this set means another package stopped letting TypeScript own its
  // declarations — a build-architecture decision that must be made on purpose.
  assert.deepEqual(
    packages
      .filter((pkg) => pkg.declarationOwner === 'tsup')
      .map((pkg) => pkg.name)
      .sort(),
    [
      '@brainstrike/chunking-worker',
      '@brainstrike/file-tree-worker',
      '@brainstrike/test-utils',
      '@brainstrike/token-cache',
    ]
  );
});
