import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { ElectronFileSystemAdapter } from '../adapters/electron-adapter';
import type { DirectoryHandle } from '../types';

// Mock electron
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

describe('Performance Benchmark', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'fs-adapter-bench-'));
    // console.log(`Created temp dir: ${tempDir}`);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { force: true, recursive: true });
  });

  it('benchmark readDirectoryStreaming with 2000 files', { timeout: 30_000 }, async () => {
    const fileCount = 2000;
    // console.log(`Creating ${fileCount} files...`);

    // Create files in parallel
    const writes = [];
    for (let i = 0; i < fileCount; i++) {
      writes.push(
        fsPromises.writeFile(path.join(tempDir, `file-${i}.txt`), `Content of file ${i}`)
      );
    }
    await Promise.all(writes);

    const adapter = new ElectronFileSystemAdapter({ cache: false });
    const handle: DirectoryHandle = {
      kind: 'directory',
      name: path.basename(tempDir),
      path: tempDir,
      platform: 'electron',
    };

    console.log('Starting readDirectoryStreaming...');
    const startRead = performance.now();

    let count = 0;
    await adapter.readDirectoryStreaming(
      handle,
      (batch) => {
        count += batch.length;
      },
      {
        batchSize: 50,
        includeMetadata: true, // This triggers the serial stat calls
      }
    );

    const duration = performance.now() - startRead;
    console.log(`[BENCHMARK] Read ${count} files in ${duration.toFixed(2)}ms`);
  });
});
