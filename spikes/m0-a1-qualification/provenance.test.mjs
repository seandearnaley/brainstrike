import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { here, prepare, provenance, verifyStateSource } from './prepare.mjs';

test('all historical bytes and pinned production source match; preparation changes only the adapter seams', () => {
  assert.equal(
    provenance.fixtureFiles.filter((file) => file.path.startsWith('original/s-dur/')).length,
    14
  );
  const runtime = prepare();
  const log = readFileSync(join(runtime, 'src/log.ts'), 'utf8');
  assert.match(log, /MeasurementCoalescer as Coalescer/);
  assert.match(log, /syncBoundary\(_threadId: string\)/);
  assert.doesNotMatch(log, /export class Coalescer/);
  assert.match(readFileSync(join(runtime, 'src/host.ts'), 'utf8'), /log: RunStore;/);
  assert.equal(
    verifyStateSource(resolve(here, '../../packages/state-store/src/index.ts')),
    resolve(here, '../../packages/state-store/src/index.ts')
  );
  assert.throws(() => verifyStateSource(undefined), /required/);
});

test('the isolated lock pins every direct dependency and closes dependencies, peers and optional platforms', () => {
  const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(here, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(Object.keys(lock.packages).length, provenance.isolatedLockPackageCount);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path) {
      assert.ok(entry.version);
      assert.match(entry.integrity, /^sha512-/);
      assert.match(entry.resolved, /^https:\/\/registry.npmjs.org\//);
    }
    const requirements = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    };
    for (const name of Object.keys(requirements)) {
      assert.ok(
        lock.packages[`${path}/node_modules/${name}`] ?? lock.packages[`node_modules/${name}`],
        `Unresolved locked dependency: ${path} -> ${name}`
      );
    }
  }
});
