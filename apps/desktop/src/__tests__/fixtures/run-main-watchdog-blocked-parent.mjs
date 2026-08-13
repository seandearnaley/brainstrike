import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

const workerPath = process.argv[2];
if (workerPath === undefined) {
  throw new Error('Expected the built main watchdog worker path');
}

const worker = new Worker(workerPath);
await new Promise((resolve, reject) => {
  worker.once('error', reject);
  worker.once('online', resolve);
});

worker.postMessage({ logPath: null, type: 'config' });
await new Promise((resolve) => setTimeout(resolve, 50));

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(waitBuffer, 0, 0, 350);
fs.writeSync(2, 'PARENT_MAIN_THREAD_UNBLOCKED\n');

await new Promise((resolve) => setTimeout(resolve, 100));
await worker.terminate();
