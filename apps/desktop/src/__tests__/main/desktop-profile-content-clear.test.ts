import { expect, test, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../../desktop-profile-runtime';

test('content clear fences replacement acquisition and retains the owner until physical retirement', async () => {
  const joined = Promise.withResolvers<{ deletedFiles: number; deletedChunks: number | null }>();
  const first = {
    acquire: vi.fn(async () => 'first'),
    clearAndRetireContent: vi.fn(() => joined.promise),
    close: vi.fn(async () => undefined),
  };
  const second = {
    acquire: vi.fn(async () => 'second'),
    clearAndRetireContent: vi.fn(() => joined.promise),
    close: vi.fn(async () => undefined),
  };
  const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const profile = createDesktopProfileRuntime<string>(create);
  await profile.acquire();
  const clearing = profile.clearAndRetireContent();
  const next = profile.acquire();
  await Promise.resolve();
  expect(profile.isRetiring()).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
  joined.resolve({ deletedChunks: null, deletedFiles: 2 });
  expect(await clearing).toEqual({ deletedChunks: null, deletedFiles: 2 });
  expect(await next).toBe('second');
  expect(first.close).not.toHaveBeenCalled();
  expect(profile.isRetiring()).toBe(false);
});

test('failed terminal content clear retains admission exclusion and the same owner', async () => {
  const failure = new Error('Physical join failed');
  const owner = {
    acquire: vi.fn(async () => 'first'),
    clearAndRetireContent: vi.fn(async () => {
      throw failure;
    }),
    close: vi.fn(async () => undefined),
  };
  const create = vi.fn(() => owner);
  const profile = createDesktopProfileRuntime(create);
  await profile.acquire();
  await expect(profile.clearAndRetireContent()).rejects.toBe(failure);
  await expect(profile.acquire()).rejects.toBe(failure);
  expect(profile.isRetiring()).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
});
