import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';

import {
  createMainWatchdogController,
  MAIN_WATCHDOG_CHECK_INTERVAL_MS,
} from './main-watchdog-core';
import { writeMainWatchdogStderrRecord } from './main-watchdog-stderr';

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
    writeMainWatchdogStderrRecord(record);
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runWithVisibleFailure(task: () => void): void {
  try {
    task();
  } catch (error) {
    writeMainWatchdogStderrRecord(
      `${JSON.stringify({
        error: errorMessage(error),
        level: 50,
        msg: 'MAIN_WATCHDOG_WORKER_FAILED',
        scope: 'MainWatchdog',
        time: new Date().toISOString(),
      })}\n`
    );
    throw error;
  }
}

parentPort.on('message', (message: unknown) => {
  runWithVisibleFailure(() => controller.handleMessage(message));
});

setInterval(() => {
  runWithVisibleFailure(() => {
    controller.check();
  });
}, MAIN_WATCHDOG_CHECK_INTERVAL_MS);
