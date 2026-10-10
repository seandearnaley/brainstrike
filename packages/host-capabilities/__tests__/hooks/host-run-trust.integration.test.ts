/**
 * A run's project hooks run only at the hash the host trusted their root at:
 * an untrusted root's file contributes nothing, a trusted one blocks through
 * its PreToolUse hook, and an edit after the trust skips it again.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustHostHooks } from '@brainstrike/agent-host';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { createHostRunHooks, trustedHookRoots } from '../../src/hooks/host-run-hooks.js';
import { writeStdoutHook } from '../fixtures/native-hook-command.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bs-host-run-trust-'));
  dirs.push(dir);
  return dir;
}

test('a project hook runs only at the hash the host trusted its root at', async () => {
  const store = await StateStore.open(tempDir());
  try {
    const workspace = tempDir();
    const blockingReads = {
      PreToolUse: [
        {
          command: writeStdoutHook(workspace, { reason: 'Project hook blocks reads' }, 2),
          matcher: { tool_name: 'readFile' },
          type: 'command',
        },
      ],
    };
    mkdirSync(join(workspace, '.brainstrike'));
    const file = join(workspace, '.brainstrike', 'hooks.json');
    writeFileSync(file, JSON.stringify(blockingReads));
    const runHooks = async () =>
      createHostRunHooks({
        globalPath: join(tempDir(), 'no-global-hooks.json'),
        maxHookTimeoutMs: 30_000,
        roots: await trustedHookRoots(store, [{ path: workspace, rootId: 'root-a' }]),
        sessionId: 'thread-1',
      });
    const read = { input: { path: 'notes.txt' }, toolName: 'brainstrike.readFile' };

    // Untrusted: the project file contributes no hook.
    expect(await runHooks()).toBeUndefined();

    await trustHostHooks(store, {
      path: workspace,
      rootId: 'root-a',
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    });
    expect(await (await runHooks())?.preToolUse(read)).toEqual({
      blocked: true,
      reason: 'Project hook blocks reads',
    });

    // Edited after the trust: skipped again until it is reviewed again.
    writeFileSync(file, JSON.stringify({ ...blockingReads, Stop: [] }));
    expect(await runHooks()).toBeUndefined();
  } finally {
    await store.close();
  }
});
