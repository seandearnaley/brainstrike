// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('the emitted desktop task host uses the registered client contract objects', async () => {
  const cache = path.resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'bst1948-task-contract-'));
  try {
    const emittedHost = path.join(directory, 'task-host.mjs');
    await build({
      bundle: true,
      entryPoints: ['src/__tests__/main/fixtures/mcp-task-contract-bundle.ts'],
      format: 'esm',
      outfile: emittedHost,
      packages: 'external',
      platform: 'node',
    });
    const { stdout } = await execute(process.execPath, [emittedHost], { timeout: 30_000 });
    const result: unknown = JSON.parse(stdout);
    expect(result).toMatchObject({ status: 'cancelled' });
    expect(result).toHaveProperty('methods', expect.arrayContaining(['tasks/get', 'tasks/cancel']));
    const methods = (result as { methods: string[] }).methods;
    expect(methods.filter((method) => method === 'tasks/cancel')).toHaveLength(1);
    expect(methods).not.toContain('tasks/update');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
