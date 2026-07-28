import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('main log transport worker', () => {
  it('loads the built target through a real Pino worker and keeps its files bounded', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-main-log-worker-'));

    try {
      const fixturePath = path.resolve(
        import.meta.dirname,
        '../fixtures/run-main-log-transport-worker.mjs'
      );
      const { stdout } = await execFileAsync(process.execPath, [fixturePath, dir]);
      const result = JSON.parse(stdout) as {
        liveContents: string;
        logFiles: readonly string[];
        sizes: readonly number[];
      };

      expect(result.logFiles).toEqual([
        'brainstrike.log',
        'brainstrike.log.1',
        'brainstrike.log.2',
      ]);
      expect(result.sizes.every((size) => size <= 320)).toBe(true);
      expect(result.liveContents).toContain('worker record 29');
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });
});
