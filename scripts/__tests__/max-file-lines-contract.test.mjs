import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// BST-1117: biome.json enforces style/noExcessiveLinesPerFile (maxLines 1000)
// for every newly linted file. Files that already exceeded the limit when the
// rule landed are grandfathered in a single explicit override; this contract
// keeps that baseline a shrink-only ratchet:
// - entries are exact paths (no globs, including [] character classes)
// - the entry count may only ever go down from its shipped starting point
// - every entry must still be flagged by Biome itself (`--only` force-runs the
//   rule past the exemption), so refactored or deleted files fall out of the
//   whitelist instead of quietly keeping a permanent exemption.
// Asking Biome — rather than re-counting lines here — matters because the rule
// counts lines up to the end of the last statement (trailing comment/blank
// lines don't count), and a hand-rolled count would drift from that.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const biomeConfigPath = path.join(repoRoot, 'biome.json');
const biomeBin = path.join(repoRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const RULE = 'lint/style/noExcessiveLinesPerFile';
const MAX_LINES = 1000;
// Current violator count. Refactoring a file under the cap removes its entry
// and lowers this ceiling in lockstep; it must never go up. (Shipped at 136;
// BST-1211 took it 126 -> 122 by deleting the preview table and shrinking
// preview-panel.tsx and its suite under the cap; BST-1258 took it 122 -> 120
// by splitting workspace-tab-host.tsx into the workspace tabs modules; BST-1650
// took it 120 -> 119 by moving the provider catalog rows out of
// provider-registry.ts into provider-catalog.json; BST-1653 took it 119 -> 118
// by extracting the database runtime and its transports out of db-provider.tsx;
// BST-1774 took it 118 -> 117 by consolidating duplicate Drizzle search tests.)
const MAX_BASELINE_ENTRIES = 117;

function isRuleOff(configured) {
  return configured === 'off' || configured?.level === 'off';
}

function findBaselineOverrides(config) {
  return (config.overrides ?? []).filter((override) =>
    isRuleOff(override.linter?.rules?.style?.noExcessiveLinesPerFile)
  );
}

function assertMaxFileLinesContract(config) {
  const rule = config.linter?.rules?.style?.noExcessiveLinesPerFile;
  assert.ok(rule, 'biome.json must configure style/noExcessiveLinesPerFile');
  assert.ok(!isRuleOff(rule), 'noExcessiveLinesPerFile must not be disabled at the top level');
  assert.equal(rule.level, 'error', 'noExcessiveLinesPerFile must be an error, not a warning');
  assert.equal(
    rule.options?.maxLines,
    MAX_LINES,
    `noExcessiveLinesPerFile must cap files at ${MAX_LINES} lines`
  );

  const baselines = findBaselineOverrides(config);
  assert.equal(
    baselines.length,
    1,
    'exactly one biome.json override may disable noExcessiveLinesPerFile (the grandfather baseline)'
  );
  const entries = baselines[0].includes ?? [];
  assert.ok(entries.length > 0, 'the grandfather baseline must not be empty');
  assert.ok(
    entries.length <= MAX_BASELINE_ENTRIES,
    `the grandfather baseline may only shrink: ${entries.length} entries > ceiling of ${MAX_BASELINE_ENTRIES}`
  );

  for (const entry of entries) {
    assert.ok(
      !/[*?{}[\]!]/u.test(entry),
      `baseline entry must be an exact path, not a glob: ${entry}`
    );
  }
  return entries;
}

function biomeFlaggedPaths(entries) {
  // --only force-runs the rule even for paths the baseline override exempts,
  // so this reports exactly the entries Biome would still flag today.
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [biomeBin, 'lint', `--only=${RULE}`, '--max-diagnostics=1000', '--reporter=json', ...entries],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (error) {
    // Biome exits non-zero when any diagnostic reaches error severity; the
    // JSON payload is still on stdout.
    if (typeof error.stdout !== 'string' || error.stdout === '') {
      throw error;
    }
    stdout = error.stdout;
  }
  const { diagnostics } = JSON.parse(stdout);
  return new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.category === RULE)
      .map((diagnostic) => diagnostic.location.path)
  );
}

function assertBaselineStillViolates(entries) {
  for (const entry of entries) {
    assert.ok(
      existsSync(path.join(repoRoot, entry)),
      `baseline entry no longer exists — remove it: ${entry}`
    );
  }
  const flagged = biomeFlaggedPaths(entries);
  for (const entry of entries) {
    assert.ok(
      flagged.has(entry),
      `Biome no longer flags this baseline entry — remove it so it stays capped: ${entry}`
    );
  }
}

const biomeConfig = JSON.parse(readFileSync(biomeConfigPath, 'utf8'));

test('biome.json enforces a 1000-line file cap with a single explicit baseline', () => {
  assertMaxFileLinesContract(biomeConfig);
});

test('every grandfathered file is still flagged by Biome (shrink-only ratchet)', () => {
  assertBaselineStillViolates(assertMaxFileLinesContract(biomeConfig));
});

test('money test: demoting the rule to warn fails the contract', () => {
  const demoted = structuredClone(biomeConfig);
  demoted.linter.rules.style.noExcessiveLinesPerFile.level = 'warn';
  assert.throws(() => assertMaxFileLinesContract(demoted), /must be an error/);
});

test('money test: raising maxLines fails the contract', () => {
  const raised = structuredClone(biomeConfig);
  raised.linter.rules.style.noExcessiveLinesPerFile.options.maxLines = 2000;
  assert.throws(() => assertMaxFileLinesContract(raised), /cap files at 1000/);
});

test('money test: a second exemption override fails the contract (string form)', () => {
  const widened = structuredClone(biomeConfig);
  widened.overrides.push({
    includes: ['packages/example/src/new-giant-file.ts'],
    linter: { rules: { style: { noExcessiveLinesPerFile: 'off' } } },
  });
  assert.throws(() => assertMaxFileLinesContract(widened), /exactly one biome\.json override/);
});

test('money test: a second exemption override fails the contract (object form)', () => {
  const widened = structuredClone(biomeConfig);
  widened.overrides.push({
    includes: ['packages/example/src/new-giant-file.ts'],
    linter: { rules: { style: { noExcessiveLinesPerFile: { level: 'off' } } } },
  });
  assert.throws(() => assertMaxFileLinesContract(widened), /exactly one biome\.json override/);
});

test('money test: growing the baseline past its ceiling fails the contract', () => {
  const widened = structuredClone(biomeConfig);
  findBaselineOverrides(widened)[0]?.includes?.push('packages/example/src/new-giant-file.ts');
  assert.throws(() => assertMaxFileLinesContract(widened), /may only shrink/);
});

test('money test: a glob baseline entry fails the contract', () => {
  const globbed = structuredClone(biomeConfig);
  const baseline = findBaselineOverrides(globbed)[0];
  // Replace (not append) so the glob check fires before the count ceiling.
  baseline.includes = [...baseline.includes.slice(0, -1), 'packages/[a-z]/giant-file.ts'];
  assert.throws(() => assertMaxFileLinesContract(globbed), /exact path, not a glob/);
});

test('money test: a baseline entry Biome no longer flags fails the ratchet', () => {
  assert.throws(
    () => assertBaselineStillViolates(['scripts/__tests__/max-file-lines-contract.test.mjs']),
    /Biome no longer flags/
  );
});
