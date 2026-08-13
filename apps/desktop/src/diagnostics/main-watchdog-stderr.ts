import fs from 'node:fs';

const MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS = 3;
const MAIN_WATCHDOG_STDERR_RETRY_DELAY_MS = 5;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

interface MainWatchdogStderrOptions {
  wait?: () => void;
  write?: (record: string) => number;
}

function isAgainError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EAGAIN';
}

export function writeMainWatchdogStderrRecord(
  record: string,
  options: MainWatchdogStderrOptions = {}
): void {
  const write = options.write ?? ((value: string) => fs.writeSync(2, value));
  const wait =
    options.wait ??
    (() => {
      Atomics.wait(waitBuffer, 0, 0, MAIN_WATCHDOG_STDERR_RETRY_DELAY_MS);
    });

  for (let attempt = 1; attempt <= MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS; attempt += 1) {
    try {
      write(record);
      return;
    } catch (error) {
      if (!(isAgainError(error) && attempt < MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS)) {
        throw error;
      }
      wait();
    }
  }
}
