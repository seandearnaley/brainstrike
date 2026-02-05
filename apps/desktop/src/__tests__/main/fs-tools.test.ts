import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleFilesystemList,
  handleFilesystemRead,
  handleFilesystemSearch,
} from '../../mcp/fs-tools';

describe('mcp fs-tools', () => {
  let rootDir: string;
  let filePath: string;
  let nestedDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-fs-'));
    nestedDir = path.join(rootDir, 'nested');
    await fs.mkdir(nestedDir, { recursive: true });

    filePath = path.join(rootDir, 'notes.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('lists files and directories under the root', async () => {
    const result = await handleFilesystemList({ path: '.' }, rootDir);

    expect(Array.isArray(result)).toBe(true);
    const entries = result as Array<{ name: string; type: string }>;
    const names = entries.map((entry) => entry.name);

    expect(names).toContain('notes.txt');
    expect(names).toContain('nested');
  });

  it('reads file contents with default maxBytes', async () => {
    const result = await handleFilesystemRead({ path: 'notes.txt' }, rootDir);
    const expectedPath = await fs.realpath(filePath);

    expect(result).toMatchObject({
      path: expectedPath,
      encoding: 'utf8',
      truncated: false,
    });
    expect((result as { content: string }).content).toContain('hello world');
  });

  it('supports base64 encoding and truncation', async () => {
    await fs.writeFile(filePath, 'a'.repeat(200), 'utf8');

    const result = await handleFilesystemRead(
      { path: 'notes.txt', encoding: 'base64', maxBytes: 32 },
      rootDir
    );

    expect(result).toMatchObject({ encoding: 'base64', truncated: true });
    expect((result as { content: string }).content.length).toBeGreaterThan(0);
  });

  it('returns an error when reading a directory', async () => {
    const result = await handleFilesystemRead({ path: 'nested' }, rootDir);
    expect(result).toEqual({ error: 'path is a directory' });
  });

  it('returns an error when query is missing for search', async () => {
    const result = await handleFilesystemSearch({}, rootDir);
    expect(result).toEqual({ error: 'query is required' });
  });

  it('searches for matching files and directories', async () => {
    await fs.writeFile(path.join(nestedDir, 'match.txt'), 'content', 'utf8');

    const result = await handleFilesystemSearch({ query: 'match', maxDepth: 2 }, rootDir);

    expect(Array.isArray(result)).toBe(true);
    const entries = result as Array<{ name: string; type: string }>;
    expect(entries.some((entry) => entry.name === 'match.txt')).toBe(true);
  });
});
