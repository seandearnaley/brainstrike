import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// These script tests start real Vitest contexts against overlapping workspaces.
// A stale shared module cache must belong to neither discovery nor fixture runs.
// Keep this cache-mutating regression in the isolated phase before repo scans.
test('concurrent script Vitest discovery and coverage leave the workspace module cache alone', async (t) => {
  const cache = path.resolve('node_modules/.vitest-cache');
  const metadata = path.join(cache, '_metadata.json');
  const sentinel = path.join(cache, `bst2245-${process.pid}`);
  const previous = await readFile(metadata).catch((error) => {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  });
  await mkdir(sentinel, { recursive: true });
  t.after(async () => {
    await rm(sentinel, { force: true, recursive: true });
    await mkdir(cache, { recursive: true });
    if (previous === undefined) {
      await rm(metadata, { force: true });
    } else {
      await writeFile(metadata, previous);
    }
  });
  await writeFile(metadata, JSON.stringify({ lockfileHash: 'previous-lockfile' }));
  await Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      writeFile(path.join(sentinel, `${index}.js`), 'previously transformed module')
    )
  );
  // Start an independent runner rather than inheriting this test child's IPC protocol.
  const env = { ...process.env };
  Reflect.deleteProperty(env, 'NODE_TEST_CONTEXT');
  const result = await execute(
    process.execPath,
    [
      '--test',
      '--test-concurrency=3',
      'scripts/__tests__/desktop-test-shard-config.test.mjs',
      'scripts/__tests__/expect-poll-default-contract.test.mjs',
      'scripts/__tests__/native-coverage.test.mjs',
    ],
    { env, maxBuffer: 8 * 1024 * 1024 }
  );
  assert.match(result.stdout, /tests [1-9]\d*\b/);
  assert.match(result.stdout, /fail 0\b/);
  assert.equal(
    await readFile(path.join(sentinel, '0.js'), 'utf8'),
    'previously transformed module'
  );
  assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), {
    lockfileHash: 'previous-lockfile',
  });
});
