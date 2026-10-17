import assert from 'node:assert/strict';
import { EventEmitter, once as nodeOnce } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const rootRequire = createRequire(`${repoRoot}/package.json`);
const vercelRequire = createRequire(rootRequire.resolve('vercel/package.json'));
const funRequire = createRequire(vercelRequire.resolve('@vercel/fun/package.json'));
const once = funRequire('@tootallnate/once').default;

// BST-871 / GHSA-vpq2-c234-7xj6: unlike the unrelated `once` package,
// @tootallnate/once leaves aborted event waits pending before 2.0.1 / 3.0.1.
// @vercel/fun pins 2.0.0 exactly; keep the override on that parent edge.
function assertPatched(lockfile) {
  const versions = Object.keys(lockfile.packages)
    .filter((key) => key.startsWith('@tootallnate/once@'))
    .map((key) => key.slice('@tootallnate/once@'.length));
  assert.ok(versions.length > 0, 'expected @tootallnate/once in the graph');
  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(
      major > 3 ||
        (major === 3 && (minor > 0 || patch >= 1)) ||
        (major === 2 && (minor > 0 || patch >= 1)),
      `vulnerable @tootallnate/once@${version}`
    );
  }
}

test('the full lock graph excludes affected once versions, with negative controls', () => {
  assertPatched(parsePnpmLockfile(readFileSync(`${repoRoot}/pnpm-lock.yaml`, 'utf8')));
  for (const version of ['1.2.0', '2.0.0', '3.0.0']) {
    assert.throws(
      () => assertPatched({ packages: { [`@tootallnate/once@${version}`]: {} } }),
      /vulnerable @tootallnate\/once/
    );
  }
  assertPatched({ packages: { '@tootallnate/once@2.0.1': {}, 'once@1.3.3': {} } });
});

test('the actual installed @vercel/fun edge resolves the patched 2.x dependency', () => {
  assert.equal(funRequire('@tootallnate/once/package.json').version, '2.0.1');
});

for (const deferred of [false, true]) {
  test(`event arguments resolve and listeners are removed (${deferred ? 'async' : 'sync'} emission)`, async () => {
    const emitter = new EventEmitter();
    const pending = once(emitter, 'finish');
    const emit = () => emitter.emit('finish', 'payload', 42);
    if (deferred) {
      process.nextTick(emit);
    } else {
      emit();
    }
    assert.deepEqual(await pending, ['payload', 42]);
    assert.equal(emitter.listenerCount('finish'), 0);
    assert.equal(emitter.listenerCount('error'), 0);
  });
}

test('emitter errors reject with the original error and remove listeners', async () => {
  const emitter = new EventEmitter();
  const pending = once(emitter, 'finish');
  const error = new Error('response failed');
  emitter.emit('error', error);
  await assert.rejects(pending, (received) => received === error);
  assert.equal(emitter.listenerCount('finish'), 0);
  assert.equal(emitter.listenerCount('error'), 0);
});

for (const alreadyAborted of [false, true]) {
  test(`abort rejects instead of hanging (${alreadyAborted ? 'before' : 'after'} registration)`, async () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    if (alreadyAborted) {
      controller.abort();
    }
    const pending = once(emitter, 'finish', { signal: controller.signal });
    controller.abort();
    // Bound the regression without leaving a vulnerable promise awaited forever.
    const settled = await Promise.race([
      pending.then(
        () => 'resolved',
        (error) => error.name
      ),
      new Promise((resolve) => setImmediate(() => resolve('pending'))),
    ]);
    assert.equal(settled, 'AbortError');
    assert.equal(emitter.listenerCount('finish'), 0);
    assert.equal(emitter.listenerCount('error'), 0);
    emitter.emit('finish');
  });
}

test('the published local fun runtime preserves HTTP invocation finish waits', {
  timeout: 5000,
}, async (t) => {
  // This published subpath exports RuntimeServer; no CLI, runtime downloads,
  // Vercel configuration, or deployment is involved.
  const { RuntimeServer } = funRequire('@vercel/fun/dist/src/runtime-server');
  const server = new RuntimeServer({});
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  );
  server.listen(0, '127.0.0.1');
  await nodeOnce(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/2018-06-01/runtime/invocation`;
  const nextReady = server.nextDeferred.promise;
  const next = fetch(`${baseUrl}/next`);
  await nextReady;
  const result = server.resultDeferred.promise;
  server.invokeDeferred.resolve({ Payload: 'input' });
  const response = await next;
  assert.equal(await response.text(), 'input');
  const requestId = response.headers.get('Lambda-Runtime-Aws-Request-Id');
  assert.ok(requestId);
  const completed = await fetch(`${baseUrl}/${requestId}/response`, {
    body: 'output',
    method: 'POST',
  });
  assert.equal(completed.status, 202);
  assert.equal(await completed.text(), '');
  assert.equal((await result).Payload, 'output');
});
