// @ts-check
// A bounded retry for the sharing-violation family that antivirus scanners (Defender real-time) cause on rename/unlink
// of a file they briefly hold open (M0-A1 src/fs-retry.ts, Windows item W-b). libuv maps ERROR_SHARING_VIOLATION /
// ERROR_ACCESS_DENIED to EBUSY / EPERM / EACCES. At most `maxAttempts` attempts with 1, 2, 4, ... 64 ms backoff; every
// retry is counted; when the bound is hit (or the error is not retryable) the failure is returned to the caller, never
// hidden. W-b measured 1,000 rename + unlink cycles with Defender on: 0 failures, 0 retries.

export const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * @typedef {object} RetryStats
 * @property {number} ops
 * @property {number} retried
 * @property {number} retries
 * @property {number} maxAttempts
 * @property {number} failures
 * @property {Record<string, number>} codes
 */

/** @returns {RetryStats} */
export const newRetryStats = () => ({
  codes: {},
  failures: 0,
  maxAttempts: 0,
  ops: 0,
  retried: 0,
  retries: 0,
});

/** @param {number} ms */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * @param {() => void} fn
 * @param {RetryStats} s
 * @param {number} [maxAttempts]
 * @param {(ms: number) => void} [sleep]
 * @returns {NodeJS.ErrnoException | null} null on success, or the final error
 */
export function retrySharing(fn, s, maxAttempts = 20, sleep = sleepSync) {
  s.ops++;
  for (let attempt = 1; ; attempt++) {
    try {
      fn();
      s.maxAttempts = Math.max(s.maxAttempts, attempt);
      if (attempt > 1) {
        s.retried++;
        s.retries += attempt - 1;
      }
      return null;
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      const code = String(err.code);
      s.codes[code] = (s.codes[code] ?? 0) + 1;
      if (!RETRYABLE.has(code) || attempt >= maxAttempts) {
        s.failures++;
        s.maxAttempts = Math.max(s.maxAttempts, attempt);
        return err;
      }
      sleep(Math.min(64, 2 ** (attempt - 1)));
    }
  }
}
