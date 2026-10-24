import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDirectoryPath } from '../utils.js';
import { createLimiter, normalizeDirectoryReadOptions } from '../utils-browser.js';

describe('utils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('normalizeDirectoryReadOptions', () => {
    it('applies defaults when options are undefined', () => {
      const result = normalizeDirectoryReadOptions();
      expect(result.includeMetadata).toBe(true);
      expect(result.concurrency).toBe(64);
      expect(typeof result.limiter).toBe('function');
    });

    it('floors finite concurrency and bypasses limiter for non-positive values', async () => {
      const result = normalizeDirectoryReadOptions({ concurrency: 2.8, includeMetadata: false });
      expect(result.includeMetadata).toBe(false);
      expect(result.concurrency).toBe(2);

      const unlimited = normalizeDirectoryReadOptions({ concurrency: 0 }).limiter;

      const task = vi.fn().mockResolvedValue('done');
      expect(await unlimited(task)).toBe('done');
      expect(task).toHaveBeenCalledTimes(1);
    });
  });

  describe('createLimiter', () => {
    it('enforces concurrency limits and drains queued tasks', async () => {
      const limiter = createLimiter(1);
      const executionOrder: number[] = [];
      let active = 0;
      let peak = 0;

      const makeTask = (id: number, delay = 0) =>
        limiter(async () => {
          active++;
          peak = Math.max(peak, active);
          executionOrder.push(id);
          await new Promise((resolve) => setTimeout(resolve, delay));
          active--;
          return id;
        });

      const results = await Promise.all([makeTask(1, 10), makeTask(2), makeTask(3)]);

      expect(results).toEqual([1, 2, 3]);
      expect(executionOrder).toEqual([1, 2, 3]);
      expect(peak).toBe(1);
    });
  });

  describe('validateDirectoryPath', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-util-'));
    });

    afterEach(async () => {
      await fsPromises.rm(tempDir, { force: true, recursive: true });
    });

    it('resolves for a valid directory', async () => {
      await expect(validateDirectoryPath(tempDir)).resolves.not.toThrow();
    });

    it('throws AccessError for a file path', async () => {
      const file = path.join(tempDir, 'file.txt');
      fs.writeFileSync(file, 'data');
      await expect(validateDirectoryPath(file)).rejects.toMatchObject({
        message: 'Selected path is not a directory',
        path: file,
      });
    });

    it('throws PermissionError when stat fails', async () => {
      vi.spyOn(fsPromises, 'stat').mockRejectedValueOnce(new Error('deny'));
      await expect(validateDirectoryPath(tempDir)).rejects.toMatchObject({
        message: 'Cannot access selected directory: deny',
        path: tempDir,
      });
    });
  });
});
