import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { probePackagedWatcher } from '../../packages/file-system/test/parcel-watch-probe.cjs';

// The probe resolves its root, so the fixture root is a real, canonical directory.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bst-probe-root-')));
after(() => rmSync(root, { force: true, recursive: true }));

test('joins native readiness before requiring exactly one create of the asserted probe', async () => {
  let callback;
  let ready = false;
  let readinessWrites = 0;
  let unsubscribed = false;
  const proofWrites = [];
  const watcher = {
    async subscribe(directory, listener, options) {
      assert.equal(directory, root);
      assert.deepEqual(options, { backend: 'windows' });
      callback = listener;
      return {
        async unsubscribe() {
          unsubscribed = true;
        },
      };
    },
  };
  await probePackagedWatcher(watcher, root, 'windows', {
    timeoutMs: 500,
    async writeFile(file) {
      if (path.basename(file) === '.watcher-readiness') {
        readinessWrites += 1;
        if (readinessWrites === 3) {
          ready = true;
        }
      } else {
        proofWrites.push(file);
      }
      // Windows queues its first ReadDirectoryChangesW on another thread.
      // Mutations before that APC runs are not delivered by the native backend.
      if (ready) {
        callback(null, [{ path: file, type: 'create' }]);
      }
    },
  });
  assert.equal(readinessWrites, 3);
  assert.deepEqual(proofWrites, [path.join(root, 'probe.txt')]);
  assert.equal(unsubscribed, true);
});

test('empty or unrelated native batches cannot satisfy the one-shot create proof', async () => {
  let callback;
  let unsubscribed = false;
  let proofWrites = 0;
  const watcher = {
    async subscribe(_directory, listener) {
      callback = listener;
      return {
        async unsubscribe() {
          unsubscribed = true;
        },
      };
    },
  };
  await assert.rejects(
    probePackagedWatcher(watcher, root, 'windows', {
      timeoutMs: 50,
      async writeFile(file) {
        if (path.basename(file) === '.watcher-readiness') {
          callback(null, [{ path: file, type: 'create' }]);
        } else {
          proofWrites += 1;
          callback(null, []);
          callback(null, [{ path: path.join(root, 'unrelated.txt'), type: 'create' }]);
          callback(null, [{ path: file, type: 'update' }]);
        }
      },
    }),
    /no packaged watcher event within 50ms/
  );
  assert.equal(proofWrites, 1, 'the asserted mutation is never retried');
  assert.equal(unsubscribed, true);
});

test('a native backend that never acknowledges readiness still fails within its budget', async () => {
  let unsubscribed = false;
  const files = [];
  const watcher = {
    async subscribe() {
      return {
        async unsubscribe() {
          unsubscribed = true;
        },
      };
    },
  };
  await assert.rejects(
    probePackagedWatcher(watcher, root, 'windows', {
      timeoutMs: 50,
      async writeFile(file) {
        files.push(file);
      },
    }),
    /no packaged watcher event within 50ms \(readiness\)/
  );
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => path.basename(file) === '.watcher-readiness'));
  assert.equal(unsubscribed, true);
});

test('timeout joins an in-flight write before unsubscribing the native watcher', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let writeFinished = false;
  let unsubscribed = false;
  const watcher = {
    async subscribe() {
      return {
        async unsubscribe() {
          assert.equal(writeFinished, true);
          unsubscribed = true;
        },
      };
    },
  };
  const proof = probePackagedWatcher(watcher, root, 'windows', {
    timeoutMs: 20,
    async writeFile() {
      started.resolve();
      await release.promise;
      writeFinished = true;
    },
  });
  await started.promise;
  await delay(30);
  assert.equal(unsubscribed, false);
  release.resolve();
  await assert.rejects(proof, /no packaged watcher event within 20ms/);
  assert.equal(unsubscribed, true);
});

test('a cleanup failure preserves the native failure as well as the unsubscribe cause', async () => {
  const nativeFailure = new Error('native failure');
  const cleanupFailure = new Error('unsubscribe failure');
  let callback;
  const watcher = {
    async subscribe(_directory, listener) {
      callback = listener;
      return {
        async unsubscribe() {
          throw cleanupFailure;
        },
      };
    },
  };
  await assert.rejects(
    probePackagedWatcher(watcher, root, 'windows', {
      timeoutMs: 500,
      async writeFile() {
        callback(nativeFailure);
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [nativeFailure, cleanupFailure]);
      return true;
    }
  );
});

test('retains a native backend failure and joins unsubscribe', async () => {
  const failure = new Error('native watcher failure');
  let callback;
  let unsubscribed = false;
  const watcher = {
    async subscribe(_directory, listener) {
      callback = listener;
      return {
        async unsubscribe() {
          unsubscribed = true;
        },
      };
    },
  };
  await assert.rejects(
    probePackagedWatcher(watcher, root, 'windows', {
      timeoutMs: 500,
      async writeFile() {
        callback(failure);
      },
    }),
    (error) => error === failure
  );
  assert.equal(unsubscribed, true);
});

test('a symlinked root is watched at the real path its backend reports (BST-2223)', async (t) => {
  // macOS: os.tmpdir() is /var/folders/…, a symlink to /private/var/folders/…,
  // and FSEvents reports the real path.
  const real = realpathSync(mkdtempSync(path.join(tmpdir(), 'bst2223-real-')));
  const linked = `${real}-link`;
  symlinkSync(real, linked, 'dir');
  t.after(() => {
    rmSync(linked, { force: true });
    rmSync(real, { force: true, recursive: true });
  });
  let callback;
  let watched;
  const watcher = {
    async subscribe(directory, listener) {
      watched = directory;
      callback = listener;
      return { async unsubscribe() {} };
    },
  };
  const reported = (file) =>
    file.startsWith(`${linked}${path.sep}`) ? path.join(real, path.relative(linked, file)) : file;
  const proof = await probePackagedWatcher(watcher, linked, 'fs-events', {
    timeoutMs: 500,
    async writeFile(file) {
      callback(null, [{ path: reported(file), type: 'create' }]);
    },
  });
  assert.equal(watched, real);
  assert.deepEqual(proof, { eventType: 'create', proofWrites: 1, readinessWrites: 1 });
});
