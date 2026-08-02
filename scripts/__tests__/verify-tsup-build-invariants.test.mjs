import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  blankComments,
  CLEAN_CLI_FLAGS,
  classifyDeclarationOwner,
  classifyFieldValue,
  DECLARATION_CLI_FLAGS,
  discoverTsupPackages,
  findGuardedFieldOccurrences,
  findTsupInvariantViolations,
  formatTsupViolations,
  GUARDED_FIELDS,
  MIN_TSUP_CONFIGS,
  MIN_TYPESCRIPT_OWNED_PACKAGES,
  OPTIONAL_FALSE_FIELDS,
  REQUIRED_FALSE_FIELDS,
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

/** A compliant TypeScript-owned config: both invariants stated as literal false. */
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
  assert.match(
    stdout,
    /tsup build invariants hold: \d+ TypeScript-owned tsup\.config\.ts file\(s\)/
  );
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

test('MONEY TEST 3: `experimentalDts` is a real bypass and FAILS the guard', () => {
  // Review round, P2 #1. Verified against installed tsup 8.5.1: `experimentalDts`
  // is a config key of its own, NOT folded into `dts`, so before this it enabled
  // tsup declaration emit while the guard reported green.
  const violations = runFixture(
    withFloorFiller({
      drifted: {
        build: TSC_BUILD,
        config: compliantConfig().replace('dts: false,', 'dts: false,\n  experimentalDts: true,'),
      },
    })
  );
  assert.equal(violations.length, 1, 'experimentalDts must not be able to walk past the guard');
  assert.equal(violations[0].field, 'experimentalDts');
  assert.equal(violations[0].kind, 'config-true');
});

test('RULE: experimentalDts may be OMITTED but not enabled', () => {
  // Asymmetric on purpose: `clean`/`dts` are the invariant and must be stated at
  // each call site; `experimentalDts` is an alternate spelling that must merely
  // never be switched on. Requiring 14 configs to write `experimentalDts: false`
  // would be noise.
  assert.deepEqual(
    runFixture(withFloorFiller({ plain: { build: TSC_BUILD, config: compliantConfig() } })),
    [],
    'omitting experimentalDts must stay legal'
  );
  for (const field of OPTIONAL_FALSE_FIELDS) {
    const violations = runFixture(
      withFloorFiller({
        drifted: {
          build: TSC_BUILD,
          config: compliantConfig().replace('dts: false,', `dts: false,\n  ${field}: true,`),
        },
      })
    );
    assert.equal(violations.length, 1, `${field} is on the optional list but is not enforced`);
    assert.equal(violations[0].field, field);
  }
});

test('MONEY TEST 4: an ABSENT clean/dts in a governed config FAILS the guard', () => {
  // Review round, P2 #2. @brainstrike/text-splitter was the live instance: it ran
  // `tsc -b . && tsup` while stating NEITHER field, yet the guard printed that
  // every governed package was "pinned to clean:false/dts:false" — an assertion
  // it had never verified.
  const bare =
    "import { defineConfig } from 'tsup';\n\nexport default defineConfig({\n  entry: ['src/index.ts'],\n});\n";
  const violations = runFixture(withFloorFiller({ bare: { build: TSC_BUILD, config: bare } }));
  assert.equal(violations.length, 2, 'both unstated invariants must be reported');
  assert.deepEqual(violations.map((violation) => violation.field).sort(), ['clean', 'dts']);
  for (const violation of violations) {
    assert.equal(violation.kind, 'config-absent');
  }
  const report = formatTsupViolations(violations);
  assert.match(report, /never states `clean`/);
  assert.match(report, /would be a silent no-op instead of a visible failure/);
  // Each required field must be independently enforced, not just as a pair.
  for (const field of REQUIRED_FALSE_FIELDS) {
    const partial = runFixture(
      withFloorFiller({
        partial: {
          build: TSC_BUILD,
          config: compliantConfig().replace(`  ${field}: false,\n`, ''),
        },
      })
    );
    assert.equal(partial.length, 1, `a missing ${field} was not detected`);
    assert.equal(partial[0].field, field);
    assert.equal(partial[0].kind, 'config-absent');
  }
});

test('RULE: a config-LESS TypeScript-owned package is not forced to grow a config', () => {
  // The explicit-statement rule applies to configs that exist. The canonical
  // strategy guard now rejects config-less real-tree tsup builds, but this
  // lower-level invariant still models CLI flags without assuming a config.
  assert.deepEqual(
    runFixture(withFloorFiller({ configless: { build: 'tsc -b . && tsup src/index.ts' } })),
    []
  );
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
  // true would otherwise walk straight through the check. The non-boolean shapes
  // tsup accepts are covered by the same rule: per its own types,
  // `clean?: boolean | string[]` and `dts?: boolean | string | DtsConfig`, and
  // every one of those non-false values ENABLES the behaviour.
  for (const expression of [
    'process.env.CI ? true : false',
    'Boolean(process.env.CLEAN)',
    "['dist']",
  ]) {
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
    const config = OPTIONAL_FALSE_FIELDS.includes(field)
      ? compliantConfig().replace('dts: false,', `dts: false,\n  ${field}: true,`)
      : compliantConfig().replace(`${field}: false`, `${field}: true`);
    const violations = runFixture(withFloorFiller({ drifted: { build: TSC_BUILD, config } }));
    assert.equal(violations.length, 1, `${field} drift was not detected`);
    assert.equal(violations[0].field, field);
  }
});

test('MONEY TEST 5: EVERY declaration CLI flag bypasses the config file and is caught', () => {
  // Review round, P2 #1 — extended past what the review named. tsup 8.5.1
  // normalises `if (flags.dts || flags.dtsResolve || flags.dtsOnly)`, so
  // --dts-resolve and --dts-only each ENABLE emit on their own; they are not
  // modifiers of --dts. All four are therefore independent bypasses.
  assert.ok(DECLARATION_CLI_FLAGS.length >= 4, 'all four tsup declaration flags must be modelled');
  for (const flag of DECLARATION_CLI_FLAGS) {
    const violations = runFixture(
      withFloorFiller({
        drifted: { build: `tsc -b . && tsup src/index.ts ${flag}`, config: compliantConfig() },
      })
    );
    assert.equal(violations.length, 1, `${flag} was not detected`);
    assert.equal(violations[0].kind, 'cli-flag');
    assert.equal(violations[0].field, 'dts');
    assert.equal(violations[0].expression, flag);
    assert.match(formatTsupViolations(violations), /Drop the flag from the build script/);
  }
  for (const flag of CLEAN_CLI_FLAGS) {
    const violations = runFixture(
      withFloorFiller({
        drifted: { build: `tsc -b . && tsup src/index.ts ${flag}`, config: compliantConfig() },
      })
    );
    assert.equal(violations.length, 1, `${flag} was not detected`);
    assert.equal(violations[0].field, 'clean');
  }
});

test('BLIND SPOT: a PATH-PREFIXED tsup invocation is still CLI-checked', () => {
  // Review round, claude[bot] note 5. `node_modules/.bin/tsup --dts` used to read
  // as "does not invoke tsup", so a config-less package was skipped entirely and
  // its flags went unchecked — the exact bypass class this guard is for.
  const violations = runFixture(
    withFloorFiller({
      pathed: { build: 'tsc -b . && node_modules/.bin/tsup src/index.ts --dts' },
    })
  );
  assert.equal(violations.length, 1, 'a path-prefixed tsup invocation must not escape the check');
  assert.equal(violations[0].kind, 'cli-flag');

  const dir = makeFixture({ packages: { pathed: { build: './node_modules/.bin/tsup --dts' } } });
  try {
    assert.ok(
      discoverTsupPackages(dir).some((pkg) => pkg.name === 'pathed'),
      'a path-prefixed invocation must be discovered as a tsup package'
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('RULE: `pnpm run clean && tsc -b . && tsup` is NOT read as a tsup --clean', () => {
  // Only segments that invoke tsup may contribute flags; a sibling `clean`
  // script in the chain is an ordered, deliberate step outside tsup.
  assert.deepEqual(readTsupCliFlags(TSC_BUILD), { clean: [], dts: [] });
  assert.deepEqual(readTsupCliFlags('pnpm run clean && tsc -b . && tsup'), { clean: [], dts: [] });
  assert.deepEqual(readTsupCliFlags('tsc -b . && tsup src/index.ts --dts --clean'), {
    clean: ['--clean'],
    dts: ['--dts'],
  });
  // `--dts-only` must report as itself, not as a loose `--dts` prefix match.
  assert.deepEqual(readTsupCliFlags('tsup --dts-only'), { clean: [], dts: ['--dts-only'] });
  // A flag belonging to a NON-tsup segment must not be attributed to tsup.
  assert.deepEqual(readTsupCliFlags('some-other-tool --clean && tsup src/index.ts'), {
    clean: [],
    dts: [],
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
  assert.match(formatTsupViolations(violations), /would publish no \.d\.ts at all/);
  // Any declaration spelling satisfies the obligation: a CLI flag with no config
  // setting, or experimentalDts instead of dts.
  assert.deepEqual(
    runFixture(
      withFloorFiller({ worker: { build: 'tsup src/index.ts --dts', config: compliantConfig() } })
    ),
    []
  );
  assert.deepEqual(
    runFixture(
      withFloorFiller({
        worker: {
          build: TSUP_ONLY_BUILD,
          config: compliantConfig().replace('dts: false,', 'dts: false,\n  experimentalDts: true,'),
        },
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

test('COMMENTS: prose that merely mentions `clean:` does NOT trip the cross-check', () => {
  // Review round, claude[bot] note 4. The permissive counter used to scan raw
  // source, so this valid config threw "an unmodelled shape is present" — an
  // error whose stated remedy was misleading for what is only a comment.
  const commented =
    "import { defineConfig } from 'tsup';\n\n" +
    '/**\n * Historical note: clean: true was removed here because tsc -b owns dist.\n */\n' +
    'export default defineConfig({\n' +
    '  // clean: kept false because tsc -b owns dist\n' +
    '  clean: false,\n' +
    '  dts: false, // dts: owned by tsc -b\n' +
    "  entry: ['src/index.ts'],\n});\n";
  const occurrences = findGuardedFieldOccurrences(commented, 'fixture.ts');
  assert.deepEqual(
    occurrences.map((entry) => entry.field),
    ['clean', 'dts']
  );
  assert.deepEqual(
    runFixture(withFloorFiller({ commented: { build: TSC_BUILD, config: commented } })),
    []
  );
});

test('COMMENTS: blanking preserves line numbers so the report points at the real line', () => {
  // A block comment collapsed to one space (the sibling stripComments' behaviour)
  // would shift every line number below it, and those numbers are printed in the
  // violation report.
  const withBlock =
    "import { defineConfig } from 'tsup';\n\n/**\n * A\n * multi-line\n * banner.\n */\nexport default defineConfig({\n  clean: true,\n  dts: false,\n});\n";
  assert.equal(blankComments(withBlock).split('\n').length, withBlock.split('\n').length);
  const occurrences = findGuardedFieldOccurrences(withBlock, 'fixture.ts');
  assert.equal(occurrences[0].field, 'clean');
  assert.equal(occurrences[0].line, 9, 'line number must survive the block comment');
});

test('WINDOWS: CRLF config lines retain the same guarded field parsing', () => {
  const windowsConfig =
    "import { defineConfig } from 'tsup';\r\n" +
    'export default defineConfig({\r\n' +
    '  clean: false, // tsc owns declarations\r\n' +
    '  dts: false,\r\n' +
    '});\r\n';

  assert.deepEqual(findGuardedFieldOccurrences(windowsConfig, 'fixture.ts'), [
    { expression: 'false', field: 'clean', kind: 'false', line: 3 },
    { expression: 'false', field: 'dts', kind: 'false', line: 4 },
  ]);
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

test('the real tree clears both floors, and the tsup-owned set is pinned', () => {
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
  // Pinned, not merely observed: these three are the ONLY packages exempt from the
  // clean/dts invariants, because they are the only ones with no `tsc -b` step.
  // Growing this set means another package stopped letting TypeScript own its
  // declarations — a build-architecture decision that must be made on purpose.
  assert.deepEqual(
    packages
      .filter((pkg) => pkg.declarationOwner === 'tsup')
      .map((pkg) => pkg.name)
      .sort(),
    ['@brainstrike/chunking-worker', '@brainstrike/file-tree-worker', '@brainstrike/token-cache']
  );
});

test('the real tree states both invariants EXPLICITLY in every governed config', () => {
  // The positive form of RULING 2, asserted directly rather than inferred from
  // "no violations": every governed config must literally contain both settings.
  let checked = 0;
  for (const pkg of discoverTsupPackages(repoRoot)) {
    if (pkg.declarationOwner !== 'typescript' || pkg.configSource === null) {
      continue;
    }
    const stated = findGuardedFieldOccurrences(pkg.configSource, pkg.configPath);
    for (const field of REQUIRED_FALSE_FIELDS) {
      const occurrence = stated.find((entry) => entry.field === field);
      assert.ok(occurrence, `${pkg.configPath} must state \`${field}\` explicitly`);
      assert.equal(occurrence.kind, 'false', `${pkg.configPath} must set \`${field}: false\``);
    }
    checked += 1;
  }
  assert.ok(
    checked >= MIN_TYPESCRIPT_OWNED_PACKAGES,
    `only ${checked} governed configs were actually asserted`
  );
});
