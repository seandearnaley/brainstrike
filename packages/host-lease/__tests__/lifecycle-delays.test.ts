import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  formatLifecycleDelays,
  LIFECYCLE_DELAYS_ENV,
  lifecycleDelay,
  parseLifecycleDelays,
  takeLifecycleDelays,
} from '../src/lifecycle-delays.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('lifecycle delay seam', () => {
  test('parses every named point and formats a subset back', () => {
    const delays = parseLifecycleDelays('host-ready:5000,platform-ready:3000,record-read:3000');
    expect([...delays]).toEqual([
      ['host-ready', 5000],
      ['platform-ready', 3000],
      ['record-read', 3000],
    ]);
    expect(formatLifecycleDelays(delays, ['record-read', 'host-ready', 'child-exit'])).toBe(
      'record-read:3000,host-ready:5000'
    );
    expect(formatLifecycleDelays(delays, ['child-exit'])).toBe('');
  });

  test('refuses an unknown or repeated point and any delay that is not a positive integer', () => {
    for (const raw of [
      '',
      'host-ready',
      'host-ready:',
      'host-ready:0',
      'host-ready:-1',
      'host-ready:1.5',
      'host-ready:1e3',
      'host-ready: 5',
      'host-ready:05',
      'host-ready:99999999999999999',
      'host-ready:5,',
      'host-redy:5',
      'host-ready:5,host-ready:6',
    ]) {
      expect(() => parseLifecycleDelays(raw), raw).toThrow(LIFECYCLE_DELAYS_ENV);
    }
  });

  test('an unset point resolves without arming a timer; a set point waits its delay', async () => {
    vi.useFakeTimers();
    const delays = parseLifecycleDelays('host-ready:5000');
    await lifecycleDelay(delays, 'record-read');
    expect(vi.getTimerCount()).toBe(0);
    let done = false;
    const waiting = lifecycleDelay(delays, 'host-ready').then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  test('a child takes its forwarded entry once and removes it for its own children', () => {
    const env: Record<string, string | undefined> = {
      [LIFECYCLE_DELAYS_ENV]: 'host-ready:5000',
      OTHER: 'kept',
    };
    expect([...takeLifecycleDelays(env)]).toEqual([['host-ready', 5000]]);
    expect(env).toEqual({ OTHER: 'kept' });
    expect(takeLifecycleDelays(env).size).toBe(0);
    expect(() => takeLifecycleDelays({ [LIFECYCLE_DELAYS_ENV]: 'nope:1' })).toThrow(
      LIFECYCLE_DELAYS_ENV
    );
  });
});
