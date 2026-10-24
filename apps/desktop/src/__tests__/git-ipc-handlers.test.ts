import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return {
    ...mod,
    default: { ...mod, spawn: spawnMock },
    spawn: spawnMock,
  };
});

import { execFileGitRunner } from '../git-ipc-handlers';

/** A git child that exits cleanly with no output. */
function exitedChild(): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  });
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(exitedChild);
});

describe('execFileGitRunner', () => {
  it('keeps unpinned command env while pinned safety keys win over overrides', async () => {
    await execFileGitRunner({
      args: ['status'],
      cwd: '/worktree',
      env: { GIT_INDEX_FILE: '/tmp/private.index', GIT_TERMINAL_PROMPT: '1' },
      timeoutMs: 5000,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const options = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options?.['env']).toMatchObject({
      GIT_INDEX_FILE: '/tmp/private.index',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    });
  });
});
