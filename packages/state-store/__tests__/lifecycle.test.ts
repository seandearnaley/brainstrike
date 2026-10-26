import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import type { StartupSpan } from '../src/state-store-types.ts';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

test('retained readers reject after close instead of waiting forever on a terminated writer', async () => {
  const store = await StateStore.open(freshDir('closed'));
  await store.close();
  for (const read of [
    () => store.read('t'),
    () => store.status('t'),
    () => store.threads(),
    () => store.check(),
  ]) {
    const result = await Promise.race([
      read().then(
        () => 'resolved',
        (error: unknown) => String(error)
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    expect(result).toMatch(/closed/);
  }
});

test('open reports each startup step, and a refused Root lock as a failed step', async () => {
  const root = freshDir('startup-spans');
  const opened: StartupSpan[] = [];
  const store = await StateStore.open(root, { onStartupSpan: (span) => opened.push(span) });
  const refused: StartupSpan[] = [];
  try {
    expect(opened.map(({ outcome, phase }) => `${phase}:${outcome}`)).toEqual([
      'root-lock:ok',
      'writer:ok',
      'deletion-recovery:ok',
    ]);
    expect(opened.every(({ durationMs }) => durationMs >= 0)).toBe(true);
    await expect(
      StateStore.open(root, { onStartupSpan: (span) => refused.push(span) })
    ).rejects.toThrow();
    expect(refused.map(({ outcome, phase }) => `${phase}:${outcome}`)).toEqual([
      'root-lock:failed',
    ]);
  } finally {
    await store.close();
  }
});
