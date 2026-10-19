'use strict';

const { realpath, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

/** Observe native readiness, then prove one exact create within the same 5s budget. */
async function probePackagedWatcher(watcher, requestedRoot, backend, options = {}) {
  // Native backends report real paths: macOS FSEvents resolves /var/folders to
  // /private/var/folders. Watch and write under that identity (BST-2223).
  const root = await realpath(requestedRoot);
  const timeoutMs = options.timeoutMs ?? 5000;
  const write = options.writeFile ?? writeFile;
  const readinessPath = path.join(root, '.watcher-readiness');
  const probePath = path.join(root, 'probe.txt');
  const controller = new AbortController();
  const { signal } = controller;
  let ready = false;
  let proved = false;
  let proofIssued = false;
  let readinessWrites = 0;
  let complete = () => undefined;
  const subscription = await watcher.subscribe(
    root,
    (error, events) => {
      if (error) {
        controller.abort(error);
        return;
      }
      for (const event of events) {
        if (event.path === readinessPath && (event.type === 'create' || event.type === 'update')) {
          ready = true;
        }
        if (proofIssued && event.path === probePath && event.type === 'create') {
          proved = true;
          complete();
        }
      }
    },
    { backend }
  );
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `no packaged watcher event within ${timeoutMs}ms (${ready ? 'probe create' : 'readiness'})`
        )
      ),
    timeoutMs
  );
  let failure;
  let failed = false;
  try {
    // Windows subscribe queues an APC; its promise does not join the first
    // ReadDirectoryChangesW. A real event acknowledges that the native watch
    // is armed. These are readiness writes, never retries of the proved create.
    while (!ready) {
      signal.throwIfAborted();
      await write(readinessPath, `readiness ${++readinessWrites}`);
      if (!ready) {
        await delay(25, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    proofIssued = true;
    await write(probePath, 'probe');
    signal.throwIfAborted();
    if (!proved) {
      let abort;
      try {
        await new Promise((resolve, reject) => {
          complete = resolve;
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        });
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
  } catch (error) {
    failed = true;
    failure = signal.aborted ? signal.reason : error;
  }
  clearTimeout(timer);
  // All writes above are joined before native teardown, including on timeout.
  try {
    await subscription.unsubscribe();
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError([failure, cleanupError], 'Watcher proof and unsubscribe failed');
    }
    throw cleanupError;
  }
  if (failed) {
    throw failure;
  }
  signal.throwIfAborted();
  return { eventType: 'create', proofWrites: 1, readinessWrites };
}

module.exports = { probePackagedWatcher };
