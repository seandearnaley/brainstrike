import './_windows-command-fixture';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  disposeLiveChildProcesses,
  runExecuteCommand,
} from '../../assistant-server/execute-command-tool';
import { singleRootRuntime } from './_tool-test-helpers';

test('preserves quoted native script paths and spaced argv through the actual shell', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'brainstrike-exec-spaced root-')));
  try {
    const script = join(root, 'quoted command.cjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const result = await runExecuteCommand(
      { command: `node "${script}" "first spaced argument" "second argument"` },
      singleRootRuntime(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(['first spaced argument', 'second argument']);
  } finally {
    await disposeLiveChildProcesses();
    await rm(root, { force: true, recursive: true });
  }
});
