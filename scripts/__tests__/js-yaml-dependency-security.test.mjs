import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rootRequire = createRequire(path.join(root, 'package.json'));
const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
const buildRequire = createRequire(vercelRequire.resolve('@vercel/build-utils'));
const pythonRequire = createRequire(buildRequire.resolve('@vercel/python-analysis'));

// These floors clear the current merge, prototype and ordered-map advisories.
function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('js-yaml@'))
    .map((key) => key.slice('js-yaml@'.length));
  assert.ok(versions.length > 0, 'expected js-yaml in the graph');
  for (const version of versions) {
    assert.match(version, /^[34]\.\d+\.\d+$/, 'review an unknown js-yaml release line');
    const [major, minor, patch] = version.split('.').map(Number);
    const floor = major === 3 ? 15 : 3;
    assert.ok(minor > floor || (minor === floor && patch >= 2), `vulnerable js-yaml@${version}`);
  }
}

test('every YAML copy clears the current advisory floors, with negative controls', async () => {
  assertPatched(parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
  for (const version of ['3.15.1', '4.1.1', '4.3.0', '4.3.1']) {
    assert.throws(() => assertPatched({ packages: { [`js-yaml@${version}`]: {} } }), /vulnerable/);
  }
  assertPatched({ packages: { 'js-yaml@3.15.2': {}, 'js-yaml@4.3.2': {} } });
  assert.throws(() => assertPatched({ packages: {} }), /expected js-yaml/);
});

test('Vercel Python YAML parsing charges empty merge sources against the budget', () => {
  const { load, YAMLException } = pythonRequire('js-yaml');
  const source = 'arr: &arr [{}, {}, {}]\ntarget: { <<: *arr }';
  assert.deepEqual(load(source), { arr: [{}, {}, {}], target: {} });
  assert.throws(
    () => load(source, { maxTotalMergeKeys: 2 }),
    (error) =>
      error instanceof YAMLException && /merge keys exceeded maxTotalMergeKeys/.test(error.reason)
  );
});

test('Vercel Python YAML parsing preserves ordinary config, merges and ordered maps', () => {
  const { load, dump, YAMLException } = pythonRequire('js-yaml');
  const config = { service: { enabled: true, name: 'api', ports: [3000, 3001] } };
  assert.deepEqual(load(dump(config)), config);
  assert.deepEqual(
    load('defaults: &defaults { port: 3000 }\nservice: { <<: *defaults, name: api }'),
    {
      defaults: { port: 3000 },
      service: { name: 'api', port: 3000 },
    }
  );
  assert.deepEqual(load('!!omap\n- first: 1\n- second: 2'), [{ first: 1 }, { second: 2 }]);
  assert.throws(() => load('service: [unterminated'), YAMLException);
});
