// @vitest-environment node

import { LIFECYCLE_DELAYS_ENV } from '@brainstrike/host-lease/lifecycle-delays';
import { afterEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock('electron', () => electron);

import { createLifecycleDelaySeam } from '../lifecycle-delay-seam';

afterEach(() => {
  electron.app.isPackaged = false;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const RAW = 'host-ready:5000,platform-ready:3000,record-read:3000';

it('applies Main points and forwards child points only in an unpackaged test-mode launch', async () => {
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
  vi.useFakeTimers();
  const env: Record<string, string | undefined> = { [LIFECYCLE_DELAYS_ENV]: RAW };
  const seam = createLifecycleDelaySeam(env);
  expect(env).toEqual({});
  expect(seam.childEnv(['host-ready', 'child-exit'])).toEqual({
    [LIFECYCLE_DELAYS_ENV]: 'host-ready:5000',
  });
  expect(seam.childEnv(['child-exit'])).toEqual({});
  let done = false;
  const waiting = seam.delay('record-read').then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(2999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  await seam.delay('child-exit');
  expect(vi.getTimerCount()).toBe(0);
  // A point fires once in Main; every child still receives its configured value.
  await seam.delay('record-read');
  expect(vi.getTimerCount()).toBe(0);
  expect(seam.childEnv(['record-read'])).toEqual({ [LIFECYCLE_DELAYS_ENV]: 'record-read:3000' });
});

it('strips the variable from Main and forwards nothing in a packaged build or outside test mode', async () => {
  vi.useFakeTimers();
  for (const [testMode, packaged] of [
    ['true', true],
    ['false', false],
  ] as const) {
    vi.stubEnv('ELECTRON_IS_E2E_TEST', testMode);
    electron.app.isPackaged = packaged;
    const env: Record<string, string | undefined> = { [LIFECYCLE_DELAYS_ENV]: RAW };
    const seam = createLifecycleDelaySeam(env);
    expect(env).toEqual({});
    expect(seam.childEnv(['host-ready'])).toEqual({});
    await seam.delay('record-read');
    expect(vi.getTimerCount()).toBe(0);
  }
  // Inert, and never parsed, when disabled: a stray malformed value cannot stop a shipped build.
  expect(() =>
    createLifecycleDelaySeam({ [LIFECYCLE_DELAYS_ENV]: 'nope' }, () => false)
  ).not.toThrow();
});

it('refuses a malformed value in an enabled launch instead of ignoring it', () => {
  for (const raw of ['', 'nope:1', 'host-ready:0', 'host-ready:1.5']) {
    expect(() => createLifecycleDelaySeam({ [LIFECYCLE_DELAYS_ENV]: raw }, () => true)).toThrow(
      LIFECYCLE_DELAYS_ENV
    );
  }
});
