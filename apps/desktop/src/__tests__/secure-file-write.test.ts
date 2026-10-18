import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureContainedDirectory,
  writeContainedFileBytes,
} from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('secure-file-write: ensureContainedDirectory', () => {
  let rootDir: string;

  beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-write-'));
    // Canonicalize so macOS's /tmp -> /private/var symlink cannot skew
    // path.relative between the root and targets created under it.
    rootDir = await fsPromises.realpath(tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsPromises.rm(rootDir, { force: true, recursive: true });
  });

  it('retains the exact missing-parent failure behind its existing safe message', async () => {
    const cause = Object.assign(new Error('PRIVATE removed parent'), { code: 'ENOENT' });
    vi.spyOn(fsPromises, 'lstat').mockRejectedValueOnce(cause);
    const pending = writeContainedFileBytes({
      buffer: Buffer.from('data'),
      requestedPath: '/notes/a.md',
      requireParentDirectory: true,
      resolved: { absolutePath: path.join(rootDir, 'notes/a.md'), canonicalRootPath: rootDir },
    });
    await expect(pending).rejects.toMatchObject({
      cause,
      message:
        'Parent directory of "/notes/a.md" no longer exists; it may have been renamed or deleted.',
    });
    await expect(pending).rejects.toSatisfy((error: Error) => error.cause === cause);
  });

  it('creates an in-root directory whose name starts with ".."', async () => {
    // BST-1256: the `relative.startsWith('..')` guard misclassified names like
    // nyc's "..__..__var" coverage dirs as outside the root and threw.
    const target = path.join(rootDir, '..__..__var__folders', 'nested');

    await ensureContainedDirectory(rootDir, target);

    const stats = await fsPromises.lstat(target);
    expect(stats.isDirectory()).toBe(true);
  });

  it('rejects a target outside the root', async () => {
    const outside = path.resolve(rootDir, '..', 'escape-target');

    await expect(ensureContainedDirectory(rootDir, outside)).rejects.toThrow(
      'outside the selected workspace root'
    );
  });
});
