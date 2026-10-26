// @vitest-environment node
// A Windows drive root keeps its separator: `C:` alone names the drive's
// current directory, not its root. Runs the engine with Windows path rules.
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { RootWatchFunction } from '../adapters/root-watchers.js';

vi.mock('node:path', async (importOriginal) => {
  const { win32 } = await importOriginal<typeof import('node:path')>();
  return { ...win32, default: win32 };
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('watches a drive root at the root, not at the drive’s current directory', async () => {
  const { startRootWatch } = await import('../adapters/root-watchers.js');
  const access = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
  let watched: string | undefined;
  const watch: RootWatchFunction = (directory) => {
    watched = directory;
    return { close: () => undefined, on: () => undefined };
  };

  const stop = await startRootWatch(
    { kind: 'directory', name: 'C:', path: 'C:\\', platform: 'electron' },
    () => undefined,
    { watch }
  );

  expect(access).toHaveBeenCalledWith('C:\\');
  expect(watched).toBe('C:\\');
  stop();
});
