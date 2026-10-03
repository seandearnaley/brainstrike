// M0-A1 guard: the bounded sharing-violation retry (src/fs-retry.mjs) on the writer's blob rename and unlink.
import { expect, test } from 'vitest';
import { newRetryStats, retrySharing } from '../src/fs-retry.mjs';

const err = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const noSleep = (): void => undefined;

test('R-retry: EPERM/EBUSY/EACCES are retried and counted until success', () => {
  const s = newRetryStats();
  let n = 0;
  expect(
    retrySharing(
      () => {
        n++;
        if (n <= 3) {
          throw err(['EPERM', 'EBUSY', 'EACCES'][n - 1] as string);
        }
      },
      s,
      20,
      noSleep
    )
  ).toBeNull();
  expect(s).toMatchObject({
    codes: { EACCES: 1, EBUSY: 1, EPERM: 1 },
    failures: 0,
    maxAttempts: 4,
    ops: 1,
    retried: 1,
    retries: 3,
  });
});

test('R-bound: a persistent sharing violation stops after maxAttempts and is returned as a failure', () => {
  const s = newRetryStats();
  let n = 0;
  const e = retrySharing(
    () => {
      n++;
      if (n > 1000) {
        throw new Error('unbounded');
      }
      throw err('EPERM');
    },
    s,
    20,
    noSleep
  );
  expect(e?.code).toBe('EPERM');
  expect(n).toBe(20);
  expect(s).toMatchObject({ failures: 1, maxAttempts: 20 });
});

test('R-only-sharing: any other error is not retried', () => {
  const s = newRetryStats();
  let n = 0;
  expect(
    retrySharing(
      () => {
        n++;
        throw err('ENOENT');
      },
      s,
      20,
      noSleep
    )?.code
  ).toBe('ENOENT');
  expect(n).toBe(1);
});
