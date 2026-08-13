import fs from 'node:fs';

const MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS = 3;
const MAIN_WATCHDOG_STDERR_RETRY_DELAY_MS = 5;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

interface MainWatchdogStderrOptions {
  wait?: () => void;
  write?: (record: Uint8Array) => number;
}

function isAgainError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EAGAIN';
}

export function writeMainWatchdogStderrRecord(
  record: string,
  options: MainWatchdogStderrOptions = {}
): void {
  const write = options.write ?? ((value: Uint8Array) => fs.writeSync(2, value));
  const wait =
    options.wait ??
    (() => {
      Atomics.wait(waitBuffer, 0, 0, MAIN_WATCHDOG_STDERR_RETRY_DELAY_MS);
    });
  let remaining = Buffer.from(record);

  for (let attempt = 1; attempt <= MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const bytesWritten = write(remaining);
      if (
        !(Number.isInteger(bytesWritten) && bytesWritten >= 0 && bytesWritten <= remaining.length)
      ) {
        throw new Error(`Invalid main watchdog stderr write count: ${bytesWritten}`);
      }
      if (bytesWritten === remaining.length) {
        return;
      }
      remaining = remaining.subarray(bytesWritten);
    } catch (error) {
      if (!(isAgainError(error) && attempt < MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS)) {
        throw error;
      }
      wait();
      continue;
    }

    if (attempt === MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS) {
      throw new Error(
        `Main watchdog stderr record remained partially written after ${MAIN_WATCHDOG_STDERR_WRITE_ATTEMPTS} attempts`
      );
    }
    wait();
  }
}
