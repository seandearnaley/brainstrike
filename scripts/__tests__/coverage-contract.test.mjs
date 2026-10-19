import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

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

test('nightly coverage expects one archive per package shard plus the merged DB archive', async () => {
  const workflow = parseYaml(
    await readFile(new URL('../../.github/workflows/nightly-coverage.yml', import.meta.url), 'utf8')
  );
  const packageShards = workflow.jobs['package-coverage'].strategy.matrix.include.length;
  const restore = workflow.jobs.coverage.steps.find(
    (step) => step.name === 'Restore coverage shards'
  );
  assert.ok(restore, 'the coverage job restores its shard archives');
  const expected = [...restore.run.matchAll(/(?:-ne |Expected )(\d+)/gu)].map(([, count]) =>
    Number(count)
  );
  assert.deepEqual(
    expected,
    [packageShards + 1, packageShards + 1],
    'adding or removing a package shard must update the archive count its merge job requires'
  );
});
