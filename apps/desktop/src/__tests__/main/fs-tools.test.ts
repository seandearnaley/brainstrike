import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleFilesystemList,
  handleFilesystemRead,
  handleFilesystemSearch,
} from '../../mcp/fs-tools';

describe('fs-tools', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-tools-'));
    await fs.mkdir(path.join(rootDir, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'alpha.txt'), 'hello world', 'utf8');
    await fs.writeFile(path.join(rootDir, 'subdir', 'beta.txt'), 'nested file', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('lists entries inside the resolved root', async () => {
    const result = await handleFilesystemList({ path: '.' }, rootDir);

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alpha.txt', type: 'file' }),
        expect.objectContaining({ name: 'subdir', type: 'dir' }),
      ])
    );
  });

  it('reads files with truncation and base64 encoding', async () => {
    const truncated = await handleFilesystemRead({ path: 'alpha.txt', maxBytes: 4 }, rootDir);

    expect(truncated).toEqual(
      expect.objectContaining({
        path: expect.stringContaining(`${path.sep}alpha.txt`),
        encoding: 'utf8',
        truncated: true,
      })
    );

    const base64Result = await handleFilesystemRead(
      { path: 'alpha.txt', encoding: 'base64', maxBytes: 5 },
      rootDir
    );

    expect(base64Result).toEqual(
      expect.objectContaining({
        encoding: 'base64',
        truncated: true,
      })
    );
  });

  it('returns an error when attempting to read a directory', async () => {
    const result = await handleFilesystemRead({ path: 'subdir' }, rootDir);

    expect(result).toEqual({ error: 'path is a directory' });
  });

  it('searches for matching names within the root', async () => {
    const results = await handleFilesystemSearch({ query: 'alpha', path: '.' }, rootDir);

    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alpha.txt', type: 'file' })])
    );
  });

  it('returns an error when search query is missing', async () => {
    const result = await handleFilesystemSearch({ path: '.' }, rootDir);

    expect(result).toEqual({ error: 'query is required' });
  });
});
