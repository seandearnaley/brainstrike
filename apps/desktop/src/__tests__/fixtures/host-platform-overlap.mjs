import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { Session } from 'node:inspector';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [entry, root] = process.argv.slice(2);
assert(entry && root, 'The fixture requires an emitted entry and disposable root');
const require = createRequire(import.meta.url);
const workerThreads = require('node:worker_threads');
const NativeWorker = workerThreads.Worker;
const stateIndexWorker = pathToFileURL(
  realpathSync(
    join(dirname(require.resolve('@brainstrike/agent-host')), 'host-state-index-worker.js')
  )
).href;
const events = [];
const workers = [];
workerThreads.Worker = class ObservedWorker extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    if (url instanceof URL && url.href === stateIndexWorker) {
      events.push('index-worker');
      workers.push(new Promise((resolve) => this.once('exit', resolve)));
    }
  }
};
syncBuiltinESMExports();
const heavyModule = pathToFileURL(
  realpathSync(join(dirname(require.resolve('@brainstrike/host-capabilities')), 'capabilities.js'))
).href;
const inspector = new Session();
inspector.connect();
inspector.on('Debugger.scriptParsed', ({ params }) => {
  if (params.url === heavyModule) {
    events.push('desktop-configuration-parsed');
  }
});
await promisify(inspector.post.bind(inspector))('Debugger.enable');
const { startAgentHost } = await import('@brainstrike/agent-host');
const { RootLock } = await import('@brainstrike/state-store');
const refusal = new Error('Recorded missing Main platform capability during startup');
// The installed utility capability slot is the existing process-local seam.
// Reject it before configuration consumes it: no credentials or Main service is used.
const slot = Promise.withResolvers();
void slot.promise.catch(() => undefined);
process[Symbol.for('brainstrike.agent-host.desktop-platform-port')] = slot;
try {
  await assert.rejects(
    startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
      const { createHostPlatform } = await import(pathToFileURL(entry).href);
      const creating = createHostPlatform({ lifetime: 'persistent', root }, startup);
      slot.reject(refusal);
      return creating;
    }),
    (cause) => cause === refusal
  );
  await Promise.all(workers);
  const lock = await RootLock.acquire(root);
  lock.release();
  process.stdout.write(
    `OVERLAP_RESULT:${JSON.stringify({ events, exited: workers.length, rootReleased: true })}\n`
  );
} finally {
  inspector.disconnect();
  workerThreads.Worker = NativeWorker;
  syncBuiltinESMExports();
  delete process[Symbol.for('brainstrike.agent-host.desktop-platform-port')];
}
