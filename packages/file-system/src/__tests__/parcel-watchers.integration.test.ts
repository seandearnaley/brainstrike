// BST-568 slice 2: startParcelWatch against the REAL native binding.
// Env-sensitive (native module + wall-clock event delivery) — integration lane.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startParcelWatch } from '../adapters/parcel-watchers';
import type { DirectoryHandle, FileSystemChange } from '../types';

function makeHandle(path: string): DirectoryHandle {
  return { kind: 'directory', name: 'root', path } as DirectoryHandle;
}

describe('startParcelWatch (real binding)', () => {
  let root = '';
  let batches: FileSystemChange[][] = [];
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-real-'));
    batches = [];
  });

  afterEach(async () => {
    stop?.();
    stop = null;
    await rm(root, { force: true, recursive: true });
  });

  it('delivers normalized add/modify/remove batches for files and directories', async () => {
    stop = await startParcelWatch(makeHandle(root), (changes) => {
      batches.push(changes);
    });

    const filePath = join(root, 'note.md');
    const dirPath = join(root, 'folder');
    await writeFile(filePath, 'v1');
    await mkdir(dirPath);

    await vi.waitFor(
      () => {
        const flat = batches.flat();
        expect(flat).toContainEqual({
          kind: 'file',
          path: filePath,
          type: 'added',
        });
        expect(flat).toContainEqual({
          kind: 'directory',
          path: dirPath,
          type: 'added',
        });
      },
      { interval: 50, timeout: 5000 }
    );

    await writeFile(filePath, 'v2');
    await vi.waitFor(
      () => {
        expect(batches.flat()).toContainEqual({
          kind: 'file',
          path: filePath,
          type: 'modified',
        });
      },
      { interval: 50, timeout: 5000 }
    );

    await rm(filePath);
    await vi.waitFor(
      () => {
        expect(batches.flat()).toContainEqual({
          kind: 'directory',
          path: filePath,
          type: 'removed',
        });
      },
      { interval: 50, timeout: 5000 }
    );
  });

  it('stops delivering events after dispose', async () => {
    stop = await startParcelWatch(makeHandle(root), (changes) => {
      batches.push(changes);
    });
    stop();
    stop = null;

    await writeFile(join(root, 'after-stop.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(batches).toEqual([]);
  });

  it('ignores events under node_modules at the native layer', async () => {
    stop = await startParcelWatch(makeHandle(root), (changes) => {
      batches.push(changes);
    });

    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'pkg.js'), 'x');
    const keptPath = join(root, 'kept.txt');
    await writeFile(keptPath, 'x');

    await vi.waitFor(
      () => {
        expect(batches.flat()).toContainEqual({
          kind: 'file',
          path: keptPath,
          type: 'added',
        });
      },
      { interval: 50, timeout: 5000 }
    );
    const flatPaths = batches.flat().map((change) => change.path);
    expect(flatPaths.some((changedPath) => changedPath.includes('node_modules'))).toBe(false);
  });
});
