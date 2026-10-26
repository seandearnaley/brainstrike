import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
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
