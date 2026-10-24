import { describe, expect, it } from 'vitest';
import { createLimiter, normalizeDirectoryReadOptions } from '../utils-browser.js';

describe('createLimiter', () => {
  it('runs tasks immediately when max <= 0 (unlimited)', async () => {
    const limiter = createLimiter(0);
    const result = await limiter(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('runs tasks immediately when max is NaN (unlimited)', async () => {
    const limiter = createLimiter(Number.NaN);
    const result = await limiter(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('runs tasks immediately when max is Infinity (unlimited)', async () => {
    const limiter = createLimiter(Number.POSITIVE_INFINITY);
    const result = await limiter(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('runs tasks up to max concurrency', async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      new Promise<void>((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active--;
          resolve();
        }, 10);
      });

    await Promise.all([limiter(task), limiter(task), limiter(task)]);
    expect(maxActive).toBe(2);
  });

  it('queues tasks when max concurrency is reached', async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];

    const makeTask = (id: number) => () =>
      new Promise<void>((resolve) => {
        order.push(id);
        setTimeout(resolve, 5);
      });

    await Promise.all([limiter(makeTask(1)), limiter(makeTask(2)), limiter(makeTask(3))]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates rejections from tasks', async () => {
    const limiter = createLimiter(1);
    await expect(limiter(() => Promise.reject(new Error('task failed')))).rejects.toThrow(
      'task failed'
    );
  });

  it('continues processing queue after a task rejects', async () => {
    const limiter = createLimiter(1);
    const results: string[] = [];

    const failTask = () => Promise.reject(new Error('fail'));
    const okTask = () => {
      results.push('ok');
      return Promise.resolve();
    };

    const p1 = limiter(failTask).catch(() => {});
    const p2 = limiter(okTask);

    await Promise.all([p1, p2]);
    expect(results).toEqual(['ok']);
  });
});

describe('normalizeDirectoryReadOptions', () => {
  it('returns defaults when no options provided', () => {
    const result = normalizeDirectoryReadOptions();
    expect(result.includeMetadata).toBe(true);
    expect(result.concurrency).toBe(64);
    expect(typeof result.limiter).toBe('function');
  });

  it('respects custom includeMetadata', () => {
    const result = normalizeDirectoryReadOptions({ includeMetadata: false });
    expect(result.includeMetadata).toBe(false);
  });

  it('respects custom concurrency', () => {
    const result = normalizeDirectoryReadOptions({ concurrency: 10 });
    expect(result.concurrency).toBe(10);
  });

  it('treats non-finite concurrency as NaN', () => {
    const result = normalizeDirectoryReadOptions({ concurrency: Number.POSITIVE_INFINITY });
    expect(Number.isNaN(result.concurrency)).toBe(true);
  });
});
