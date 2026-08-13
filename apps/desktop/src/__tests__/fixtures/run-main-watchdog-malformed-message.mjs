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

worker.removeAllListeners('error');
worker.once('error', () => undefined);
const exitCode = new Promise((resolve) => worker.once('exit', resolve));
worker.postMessage(null);
await exitCode;
fs.writeSync(2, 'WATCHDOG_WORKER_EXITED\n');
