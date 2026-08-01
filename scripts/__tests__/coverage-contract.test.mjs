import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const biomeConfig = JSON.parse(await readFile(new URL('../../biome.json', import.meta.url)));
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));

test('root coverage scripts keep DB out of the normal workspace coverage path', () => {
  const coverageScript = packageJson.scripts['test:coverage'];
  const baseCoverageScript = packageJson.scripts['test:coverage:base'];

  assert.match(coverageScript, /--filter=['"]?!@brainstrike\/db['"]?/);
  assert.match(baseCoverageScript, /--filter ['"]?!@brainstrike\/db['"]?/);
});

test('root coverage split leaves DB to the dedicated native nightly shards', () => {
  assert.doesNotMatch(packageJson.scripts['test:coverage:split'], /test:coverage:db:/);
});

function assertGeneratedCoverageIsExcluded(config) {
  assert.ok(
    config.files?.includes?.includes('!**/coverage-*'),
    'Biome must exclude generated per-shard coverage directories'
  );
}

test('generated per-shard coverage reports cannot poison the lint gate', () => {
  assertGeneratedCoverageIsExcluded(biomeConfig);
});

test('money test: removing the generated coverage exclusion fails the contract', () => {
  const mutated = structuredClone(biomeConfig);
  mutated.files.includes = mutated.files.includes.filter((entry) => entry !== '!**/coverage-*');
  assert.throws(
    () => assertGeneratedCoverageIsExcluded(mutated),
    /exclude generated per-shard coverage directories/
  );
});
