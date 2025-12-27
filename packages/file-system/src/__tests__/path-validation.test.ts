import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TRAVERSAL_LIMIT, resolveValidatedPath } from '../path-validation';

describe('resolveValidatedPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-validate-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves paths inside the configured root', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '.',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(await fsPromises.realpath(tempDir));
    }
  });

  it('rejects null bytes', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '/tmp/\0oops',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('null-byte');
    }
  });

  it('uses the fallback when the requested path is empty', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '',
      fallbackPath: 'fallback-folder',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(result.path).toBe(path.join(rootReal, 'fallback-folder'));
    }
  });

  it('rejects when requested and fallback are blank', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '   ',
      fallbackPath: ' ',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-input');
    }
  });

  it('rejects excessive traversal', async () => {
    const traversal = '../'.repeat(DEFAULT_TRAVERSAL_LIMIT + 1);
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: traversal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('traversal');
    }
  });

  it('rejects paths outside the root when missing', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: '../outside-root',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('outside-root');
    }
  });

  it('allows missing paths inside the root', async () => {
    const result = await resolveValidatedPath({
      rootDir: tempDir,
      requestedPath: 'missing-folder',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const rootReal = await fsPromises.realpath(tempDir);
      expect(result.path).toBe(path.join(rootReal, 'missing-folder'));
    }
  });

  it('rejects sensitive directories on unix', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const result = await resolveValidatedPath({
      requestedPath: '/etc/passwd',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('sensitive-path');
    }
  });
});
