import { flushCompileCache, getCompileCacheDir } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { proofTiming } from '@brainstrike/host-lease';
import { runIndexerProcess } from '@brainstrike/indexer/host';

// BST-2239 proof only: what the state-index worker does between its close answer and its exit.
proofTiming('BST-2239 state-index worker started', { compileCache: getCompileCacheDir() ?? null });
process.on('exit', (code) => {
  proofTiming('BST-2239 state-index worker exit event', { code });
});
function proofFinish(close: () => void): void {
  proofTiming('BST-2239 state-index worker finish', {
    activeResources: process.getActiveResourcesInfo(),
    compileCache: getCompileCacheDir() ?? null,
  });
  const startedAt = Date.now();
  flushCompileCache();
  proofTiming('BST-2239 state-index worker compile cache flushed', {
    elapsedMs: Date.now() - startedAt,
  });
  close();
  proofTiming('BST-2239 state-index worker port closed', {
    activeResources: process.getActiveResourcesInfo(),
  });
}

// The derived state index engine runs on its own thread (it starts its own writer
// worker), so indexing never shares the Core event loop or the canonical writer.
const port = parentPort;
if (!port) {
  throw new Error('The host state index engine must run in a worker thread');
}
port.once('message', (input: unknown) => {
  runIndexerProcess(input, {
    finish: () => proofFinish(() => port.close()),
    onDisconnect: (listener) => {
      port.on('close', listener);
    },
    onMessage: (listener) => {
      port.on('message', listener);
    },
    send: (value) => {
      port.postMessage(value);
      if ((value as { kind?: unknown }).kind === 'ready') {
        // BST-2239 proof only: what persisting this worker's compile cache costs once it is ready.
        setImmediate(() => {
          const startedAt = Date.now();
          flushCompileCache();
          proofTiming('BST-2239 state-index worker compile cache flushed after ready', {
            elapsedMs: Date.now() - startedAt,
          });
        });
      }
    },
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
    port.close();
  });
});
