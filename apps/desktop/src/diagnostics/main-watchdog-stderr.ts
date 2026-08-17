import fs from 'node:fs';

const MAIN_WATCHDOG_STDERR_MAX_STALLED_ATTEMPTS = 3;
const MAIN_WATCHDOG_STDERR_MAX_WRITE_CALLS = 64;
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
  let stalledAttempts = 0;

  for (let writeCall = 1; writeCall <= MAIN_WATCHDOG_STDERR_MAX_WRITE_CALLS; writeCall += 1) {
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
      if (bytesWritten > 0) {
        remaining = remaining.subarray(bytesWritten);
        stalledAttempts = 0;
      } else {
        stalledAttempts += 1;
      }
    } catch (error) {
      if (!isAgainError(error)) {
        throw error;
      }
      stalledAttempts += 1;
      if (stalledAttempts >= MAIN_WATCHDOG_STDERR_MAX_STALLED_ATTEMPTS) {
        throw error;
      }
      if (writeCall === MAIN_WATCHDOG_STDERR_MAX_WRITE_CALLS) {
        throw new Error(
          `Main watchdog stderr record exceeded ${MAIN_WATCHDOG_STDERR_MAX_WRITE_CALLS} write calls`
        );
      }
      wait();
      continue;
    }

    if (stalledAttempts >= MAIN_WATCHDOG_STDERR_MAX_STALLED_ATTEMPTS) {
      throw new Error(
        `Main watchdog stderr record remained stalled after ${MAIN_WATCHDOG_STDERR_MAX_STALLED_ATTEMPTS} attempts`
      );
    }
    if (writeCall === MAIN_WATCHDOG_STDERR_MAX_WRITE_CALLS) {
      throw new Error(
        `Main watchdog stderr record exceeded ${MAIN_WATCHDOG_STDERR_MAX_WRITE_CALLS} write calls`
      );
    }
    wait();
  }
}
