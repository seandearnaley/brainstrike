import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const rootRequire = createRequire(`${repoRoot}/package.json`);
const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
const backendsRequire = createRequire(vercelRequire.resolve('@vercel/backends/package.json'));
const ownerRequire = createRequire(backendsRequire.resolve('@vercel/static-config/package.json'));
const Ajv = ownerRequire('ajv');
const { Project } = ownerRequire('ts-morph');
const { getConfig } = backendsRequire('@vercel/static-config');

// BST-873 / GHSA-2g4f-4pwh-qvx6: 6.14 and 8.18 are the patched floors.
// Preserve safe 6.x consumers; the override belongs only to static-config.
function assertPatched(lockfile) {
  const versions = Object.keys(lockfile.packages)
    .filter((key) => key.startsWith('ajv@'))
    .map((key) => key.slice('ajv@'.length));
  assert.ok(versions.length > 0, 'expected Ajv in the graph');
  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const [major, minor] = version.split('.').map(Number);
    assert.ok(
      major > 8 || (major === 8 && minor >= 18) || (major === 6 && minor >= 14),
      `vulnerable ajv@${version}`
    );
  }
}

test('the whole lock graph excludes affected Ajv copies, with negative controls', () => {
  assertPatched(parsePnpmLockfile(readFileSync(`${repoRoot}/pnpm-lock.yaml`, 'utf8')));
  for (const version of ['6.13.0', '7.2.4', '8.6.3', '8.17.1']) {
    assert.throws(() => assertPatched({ packages: { [`ajv@${version}`]: {} } }), /vulnerable ajv/);
  }
  assertPatched({ packages: { 'ajv@6.15.0': {}, 'ajv@8.18.0': {}, 'ajv@8.20.0': {} } });
});

test('the actual installed static-config edge resolves patched Ajv 8.x', () => {
  assert.equal(ownerRequire('ajv/package.json').version, '8.18.0');
});

test('$data patterns invoke the configured engine with benign input', () => {
  const calls = [];
  function configuredRegExp(pattern, flags) {
    calls.push([pattern, flags]);
    return new RegExp(pattern, flags);
  }
  configuredRegExp.code = 'configuredRegExp';
  const ajv = new Ajv({ $data: true, code: { regExp: configuredRegExp } });
  const validate = ajv.compile({
    properties: {
      pattern: { type: 'string' },
      value: { pattern: { $data: '1/pattern' }, type: 'string' },
    },
    type: 'object',
  });
  assert.equal(validate({ pattern: '^[a-z]+$', value: 'abc' }), true);
  assert.equal(validate({ pattern: '^[a-z]+$', value: '123' }), false);
  assert.deepEqual(calls, [
    ['^[a-z]+$', 'u'],
    ['^[a-z]+$', 'u'],
  ]);
});

function readConfig(source, schema) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-static-config-'));
  const sourcePath = path.join(directory, 'function.ts');
  try {
    writeFileSync(sourcePath, source);
    return getConfig(new Project(), sourcePath, schema);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test('public getConfig preserves valid, invalid and missing configuration', () => {
  const config = { architecture: 'arm64', maxDuration: 'max', memory: 128, regions: ['iad1'] };
  assert.deepEqual(
    readConfig(
      'export const config = {architecture:"arm64", memory:128, regions:["iad1"], maxDuration:"max"}'
    ),
    config
  );
  assert.throws(() => readConfig('export const config = {memory:"128"}'), /Invalid data/);
  assert.equal(readConfig('export const unrelated = {memory:128}'), null);
  assert.equal(readConfig('const config = {memory:128}'), null);
});

test('public getConfig validates custom schemas and local $ref constraints', () => {
  const schema = {
    additionalProperties: false,
    definitions: { memory: { minimum: 128, type: 'integer' } },
    properties: { memory: { $ref: '#/definitions/memory' } },
    required: ['memory'],
    type: 'object',
  };
  assert.deepEqual(readConfig('export const config = {memory:128}', schema), { memory: 128 });
  assert.throws(() => readConfig('export const config = {memory:64}', schema), /Invalid data/);
  assert.throws(
    () => readConfig('export const config = {memory:128, extra:true}', schema),
    /Invalid data/
  );
});

test('public getConfig preserves strict schema errors and disabled $data', () => {
  assert.throws(
    () =>
      readConfig('export const config = {}', {
        type: 'object',
        unknownKeyword: true,
      }),
    /strict mode: unknown keyword/
  );
  assert.throws(
    () =>
      readConfig('export const config = {value:"abc"}', {
        properties: { value: { pattern: { $data: '1/pattern' }, type: 'string' } },
        type: 'object',
      }),
    /schema is invalid/
  );
});

test('public getConfig preserves URI-based schema references', () => {
  const schema = {
    $id: 'https://example.test/config.json',
    definitions: { region: { enum: ['iad1'], type: 'string' } },
    properties: { region: { $ref: 'https://example.test/config.json#/definitions/region' } },
    type: 'object',
  };
  assert.deepEqual(readConfig('export const config = {region:"iad1"}', schema), { region: 'iad1' });
  assert.throws(
    () => readConfig('export const config = {region:"invalid"}', schema),
    /Invalid data/
  );
});
