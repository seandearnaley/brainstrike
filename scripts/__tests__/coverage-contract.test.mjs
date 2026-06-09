import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));

test('root coverage scripts keep DB out of the normal workspace coverage path', () => {
  const coverageScript = packageJson.scripts['test:coverage'];
  const baseCoverageScript = packageJson.scripts['test:coverage:base'];

  assert.match(coverageScript, /--filter=['"]?!@brainstrike\/db['"]?/);
  assert.match(baseCoverageScript, /--filter ['"]?!@brainstrike\/db['"]?/);
});

test('root coverage split keeps DB on explicit dedicated coverage lanes', () => {
  assert.doesNotMatch(packageJson.scripts['test:coverage:split'], /test:coverage:db:/);
});
