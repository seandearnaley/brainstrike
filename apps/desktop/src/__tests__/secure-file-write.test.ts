import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureContainedDirectory } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('secure-file-write: ensureContainedDirectory', () => {
  let rootDir: string;

  beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-write-'));
    // Canonicalize so macOS's /tmp -> /private/var symlink cannot skew
    // path.relative between the root and targets created under it.
    rootDir = await fsPromises.realpath(tempDir);
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { force: true, recursive: true });
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
