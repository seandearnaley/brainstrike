import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';

import {
  createMainWatchdogController,
  MAIN_WATCHDOG_CHECK_INTERVAL_MS,
} from './main-watchdog-core';

if (parentPort === null) {
  throw new Error('Main watchdog worker requires a worker-thread parent port');
}

const controller = createMainWatchdogController({
  appendFile: (logPath, record) => {
    fs.appendFileSync(logPath, record, 'utf8');
  },
  elapsedNow: () => performance.now(),
  getCpuUsage: () => process.cpuUsage(),
  getMemoryUsage: () => process.memoryUsage(),
  wallNow: () => Date.now(),
  writeStderr: (record) => {
    process.stderr.write(record);
  },
});

parentPort.on('message', (message: unknown) => {
  controller.handleMessage(message);
});

setInterval(() => {
  controller.check();
}, MAIN_WATCHDOG_CHECK_INTERVAL_MS);
