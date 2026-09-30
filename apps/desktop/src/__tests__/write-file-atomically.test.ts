import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsyncDirectory } from '../write-file-atomically';

describe('fsyncDirectory', () => {
  let missingDirectory: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'brainstrike-fsync-directory-'));
    missingDirectory = path.join(root, 'absent');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { force: true, recursive: true });
  });

  it('opens and flushes the directory, so a directory that cannot be opened throws', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    expect(() => fsyncDirectory(missingDirectory)).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
    expect(() => fsyncDirectory(root)).not.toThrow();
  });

  it('skips the flush on Windows, where Node cannot open a directory handle', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    // The same missing directory that throws above: only the platform differs, so the early return
    // is what spares it.
    expect(() => fsyncDirectory(missingDirectory)).not.toThrow();
  });
});
