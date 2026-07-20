// Unit coverage for the synthetic-tree generator used by the BST-568
// watcher benchmark (scripts/watcher-benchmark.mjs). Small N here; the
// benchmark script runs the 30k-directory shape out-of-band.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSyntheticTree } from '../../scripts/watcher-benchmark.mjs';

async function countTree(root: string): Promise<{ dirs: number; files: number }> {
  let dirs = 0;
  let files = 0;
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      break;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs += 1;
        pending.push(join(dir, entry.name));
      } else {
        files += 1;
      }
    }
  }
  return { dirs, files };
}

describe('generateSyntheticTree', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bst568-tree-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('creates exactly the requested directory and file counts', async () => {
    await generateSyntheticTree(root, { dirs: 57, filesPerDir: 2 });
    const counts = await countTree(root);
    expect(counts.dirs).toBe(57);
    expect(counts.files).toBe(57 * 2);
  });

  it('bounds fanout so deep trees stay balanced', async () => {
    await generateSyntheticTree(root, { dirs: 40, filesPerDir: 0 });
    const topLevel = await readdir(root, { withFileTypes: true });
    const topDirs = topLevel.filter((entry) => entry.isDirectory());
    // MAX_FANOUT is 16: 40 dirs cannot all sit at the root.
    expect(topDirs.length).toBeLessThanOrEqual(16);
    const counts = await countTree(root);
    expect(counts.dirs).toBe(40);
  });

  it('rejects non-positive dir counts loudly', async () => {
    await expect(generateSyntheticTree(root, { dirs: 0, filesPerDir: 1 })).rejects.toThrow(
      /dirs must be a positive integer/
    );
  });
});
