import { parentPort } from 'node:worker_threads';
import { runIndexerProcess } from '@brainstrike/indexer/host';

// The derived state index engine runs on its own thread (it starts its own writer
// worker), so indexing never shares the Core event loop or the canonical writer.
const port = parentPort;
if (!port) {
  throw new Error('The host state index engine must run in a worker thread');
}
port.once('message', (input: unknown) => {
  runIndexerProcess(input, {
    finish: () => port.close(),
    onDisconnect: (listener) => {
      port.on('close', listener);
    },
    onMessage: (listener) => {
      port.on('message', listener);
    },
    send: (value) => port.postMessage(value),
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
    port.close();
  });
});
