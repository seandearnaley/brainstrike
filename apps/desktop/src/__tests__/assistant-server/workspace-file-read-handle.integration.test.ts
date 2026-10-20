import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runReadWorkspaceFile } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { singleRootRuntime } from './_tool-test-helpers';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-read-handle-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { force: true, recursive: true });
});

describe('live workspace file reader handle guards', () => {
  it('refuses a directory through the direct file tool', async () => {
    await fs.mkdir(path.join(root, 'directory'));
    await expect(
      runReadWorkspaceFile({ path: '/directory' }, singleRootRuntime(root), null)
    ).rejects.toThrow();
  });

  it('refuses a file that shrinks during a read and closes the admitted handle', async () => {
    const file = path.join(root, 'changing.txt');
    await fs.writeFile(file, 'hello');
    const open = fs.open;
    const handles: FileHandle[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (requested, flags, mode) => {
      const handle = await open(requested, flags, mode);
      if (requested !== file) {
        return handle;
      }
      handles.push(handle);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce(async (options) => {
        const initial = await stat(options);
        await fs.truncate(file, 2);
        return initial;
      });
      return handle;
    });

    await expect(
      runReadWorkspaceFile({ path: '/changing.txt' }, singleRootRuntime(root), null)
    ).rejects.toThrow('Path "/changing.txt" changed while it was being read. Retry.');
    expect(handles).toHaveLength(1);
    expect(handles[0]?.fd).toBe(-1);
  });
});
