import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// BST-1117: biome.json enforces style/noExcessiveLinesPerFile (maxLines 1000)
// for every newly linted file. Files that already exceeded the limit when the
// rule landed are grandfathered in a single explicit override; this contract
// keeps that baseline a shrink-only ratchet — entries must be exact paths that
// still exist and still exceed the limit, so refactored or deleted files fall
// out of the whitelist instead of quietly re-earning headroom.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const biomeConfigPath = path.join(repoRoot, 'biome.json');
const MAX_LINES = 1000;

function countLines(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (content === '') {
    return 0;
  }
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

function findBaselineOverrides(config) {
  return (config.overrides ?? []).filter(
    (override) => override.linter?.rules?.style?.noExcessiveLinesPerFile === 'off'
  );
}

function assertMaxFileLinesContract(config) {
  const rule = config.linter?.rules?.style?.noExcessiveLinesPerFile;
  assert.ok(rule, 'biome.json must configure style/noExcessiveLinesPerFile');
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

  for (const entry of entries) {
    assert.ok(
      !/[*?{}!]/u.test(entry),
      `baseline entry must be an exact path, not a glob: ${entry}`
    );
  }
  return entries;
}

function assertBaselineStillViolates(entries) {
  for (const entry of entries) {
    const filePath = path.join(repoRoot, entry);
    assert.ok(existsSync(filePath), `baseline entry no longer exists — remove it: ${entry}`);
    const lines = countLines(filePath);
    assert.ok(
      lines > MAX_LINES,
      `baseline entry is down to ${lines} lines (≤ ${MAX_LINES}) — remove it so it stays capped: ${entry}`
    );
  }
}

const biomeConfig = JSON.parse(readFileSync(biomeConfigPath, 'utf8'));

test('biome.json enforces a 1000-line file cap with a single explicit baseline', () => {
  assertMaxFileLinesContract(biomeConfig);
});

test('every grandfathered file still exceeds the cap (shrink-only ratchet)', () => {
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

test('money test: a second exemption override fails the contract', () => {
  const widened = structuredClone(biomeConfig);
  widened.overrides.push({
    includes: ['packages/example/src/new-giant-file.ts'],
    linter: { rules: { style: { noExcessiveLinesPerFile: 'off' } } },
  });
  assert.throws(() => assertMaxFileLinesContract(widened), /exactly one biome\.json override/);
});

test('money test: a glob baseline entry fails the contract', () => {
  const globbed = structuredClone(biomeConfig);
  findBaselineOverrides(globbed)[0]?.includes?.push('packages/**/giant-*.ts');
  assert.throws(() => assertMaxFileLinesContract(globbed), /exact path, not a glob/);
});

test('money test: a baseline entry that shrank below the cap fails the ratchet', () => {
  assert.throws(
    () => assertBaselineStillViolates(['scripts/__tests__/max-file-lines-contract.test.mjs']),
    /down to \d+ lines/
  );
});
