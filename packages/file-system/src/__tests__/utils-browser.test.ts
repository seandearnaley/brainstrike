import type { DirectoryHandle } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  createLimiter,
  extractNativeDirectoryHandle,
  extractNativeDirectoryHandleAsNull,
  extractNativeDirectoryHandleAsUndefined,
  isFileSystemDirectoryHandle,
  isFileSystemFileHandle,
  isValidDirectoryHandle,
  normalizeDirectoryReadOptions,
} from '../utils-browser';

function makeHandle(overrides: Partial<DirectoryHandle> = {}): DirectoryHandle {
  return {
    _internal: { fake: 'handle' },
    kind: 'directory',
    name: 'test',
    path: '/test',
    platform: 'web',
    ...overrides,
  };
}

describe('extractNativeDirectoryHandle', () => {
  it('returns null for null input', () => {
    expect(extractNativeDirectoryHandle(null)).toBeNull();
  });

  it('returns undefined for undefined input', () => {
    expect(extractNativeDirectoryHandle(undefined)).toBeUndefined();
  });

  it('returns _internal for web platform', () => {
    const internal = { fake: 'handle' };
    const handle = makeHandle({ _internal: internal, platform: 'web' });
    expect(extractNativeDirectoryHandle(handle)).toBe(internal);
  });

  it('returns _internal when platform is undefined', () => {
    const internal = { fake: 'handle' };
    const handle = makeHandle({ _internal: internal });
    // Override platform to undefined to test that branch
    (handle as unknown as Record<string, unknown>)['platform'] = undefined;
    expect(extractNativeDirectoryHandle(handle)).toBe(internal);
  });

  it('returns null for non-web platform (electron)', () => {
    const handle = makeHandle({ platform: 'electron' });
    expect(extractNativeDirectoryHandle(handle)).toBeNull();
  });
});

describe('extractNativeDirectoryHandleAsUndefined', () => {
  it('returns undefined for null input', () => {
    expect(extractNativeDirectoryHandleAsUndefined(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(extractNativeDirectoryHandleAsUndefined(undefined)).toBeUndefined();
  });

  it('returns _internal for web platform', () => {
    const internal = { fake: 'handle' };
    const handle = makeHandle({ _internal: internal, platform: 'web' });
    expect(extractNativeDirectoryHandleAsUndefined(handle)).toBe(internal);
  });
});

describe('extractNativeDirectoryHandleAsNull', () => {
  it('returns null for null input', () => {
    expect(extractNativeDirectoryHandleAsNull(null)).toBeNull();
  });

  it('returns null for undefined input (converts undefined to null)', () => {
    expect(extractNativeDirectoryHandleAsNull(undefined)).toBeNull();
  });

  it('returns _internal for web platform', () => {
    const internal = { fake: 'handle' };
    const handle = makeHandle({ _internal: internal, platform: 'web' });
    expect(extractNativeDirectoryHandleAsNull(handle)).toBe(internal);
  });

  it('returns null for electron platform', () => {
    const handle = makeHandle({ platform: 'electron' });
    expect(extractNativeDirectoryHandleAsNull(handle)).toBeNull();
  });
});

describe('isValidDirectoryHandle', () => {
  it('returns true for valid directory handle', () => {
    expect(isValidDirectoryHandle(makeHandle())).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidDirectoryHandle(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidDirectoryHandle(undefined)).toBe(false);
  });

  it('returns false for handle with wrong kind', () => {
    const handle = makeHandle();
    (handle as unknown as Record<string, unknown>)['kind'] = 'file';
    expect(isValidDirectoryHandle(handle)).toBe(false);
  });
});

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

describe('isFileSystemDirectoryHandle', () => {
  it('returns true for valid directory handle shape', () => {
    expect(
      isFileSystemDirectoryHandle({
        entries: () => {},
        kind: 'directory',
        name: 'test',
      })
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(isFileSystemDirectoryHandle(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isFileSystemDirectoryHandle(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isFileSystemDirectoryHandle('string')).toBe(false);
  });

  it('returns false for wrong kind', () => {
    expect(
      isFileSystemDirectoryHandle({
        entries: () => {},
        kind: 'file',
        name: 'test',
      })
    ).toBe(false);
  });

  it('returns false when name is not a string', () => {
    expect(
      isFileSystemDirectoryHandle({
        entries: () => {},
        kind: 'directory',
        name: 123,
      })
    ).toBe(false);
  });

  it('returns false when entries method is missing', () => {
    expect(
      isFileSystemDirectoryHandle({
        kind: 'directory',
        name: 'test',
      })
    ).toBe(false);
  });
});

describe('isFileSystemFileHandle', () => {
  it('returns true for valid file handle shape', () => {
    expect(
      isFileSystemFileHandle({
        getFile: () => {},
        kind: 'file',
        name: 'test.txt',
      })
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(isFileSystemFileHandle(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isFileSystemFileHandle(undefined)).toBe(false);
  });

  it('returns false for wrong kind', () => {
    expect(
      isFileSystemFileHandle({
        getFile: () => {},
        kind: 'directory',
        name: 'test',
      })
    ).toBe(false);
  });

  it('returns false when name is not a string', () => {
    expect(
      isFileSystemFileHandle({
        getFile: () => {},
        kind: 'file',
        name: 42,
      })
    ).toBe(false);
  });

  it('returns false when getFile method is missing', () => {
    expect(
      isFileSystemFileHandle({
        kind: 'file',
        name: 'test.txt',
      })
    ).toBe(false);
  });
});
