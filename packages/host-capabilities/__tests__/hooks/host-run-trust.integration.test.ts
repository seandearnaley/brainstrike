/**
 * A run's project hooks run only at a hash the host approved for their root:
 * an unapproved root's file contributes nothing, an approved one blocks
 * through its PreToolUse hook, and an edit after the approval skips it again,
 * reported as changed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustHostHooks } from '@brainstrike/agent-host';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import {
  createHostRunHooks,
  loadHostRunHooks,
  trustedHookRoots,
} from '../../src/hooks/host-run-hooks.js';
import { writeStdoutHook } from '../fixtures/native-hook-command.js';
import { windowsCommandEntry } from '../fixtures/windows-command-entry.js';

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
    const runOptions = async () => ({
      globalPath: join(tempDir(), 'no-global-hooks.json'),
      maxHookTimeoutMs: 30_000,
      roots: await trustedHookRoots(store, [{ path: workspace, rootId: 'root-a' }]),
      sessionId: 'thread-1',
      windowsCommandEntry,
    });
    const runHooks = async () => createHostRunHooks(await runOptions());
    const read = { input: { path: 'notes.txt' }, toolName: 'brainstrike.readFile' };

    // Untrusted: the project file contributes no hook.
    expect(await runHooks()).toBeUndefined();

    await trustHostHooks(store, {
      path: workspace,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    });
    expect(await (await runHooks())?.preToolUse(read)).toEqual({
      blocked: true,
      reason: 'Project hook blocks reads',
    });

    // Edited after the trust: skipped again until it is reviewed again, and reported as changed.
    writeFileSync(file, JSON.stringify({ ...blockingReads, Stop: [] }));
    expect(await runHooks()).toBeUndefined();
    expect(loadHostRunHooks(await runOptions()).skipped).toMatchObject([
      { path: file, reason: 'changed', rootId: 'root-a' },
    ]);
  } finally {
    await store.close();
  }
});
