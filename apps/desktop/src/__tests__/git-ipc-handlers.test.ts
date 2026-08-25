import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: readonly string[],
      _options: Record<string, unknown>,
      callback: ExecFileCallback
    ) => {
      callback(null, '', '');
    }
  )
);

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return {
    ...mod,
    default: { ...mod, execFile: execFileMock },
    execFile: execFileMock,
  };
});

import { execFileGitRunner } from '../git-ipc-handlers';

beforeEach(() => {
  execFileMock.mockClear();
});

describe('execFileGitRunner', () => {
  it('merges a per-command env override over the pinned git environment', async () => {
    await execFileGitRunner({
      args: ['status'],
      cwd: '/worktree',
      env: { GIT_INDEX_FILE: '/tmp/private.index' },
      timeoutMs: 5000,
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const options = execFileMock.mock.calls[0]?.[2];
    expect(options?.['env']).toMatchObject({
      GIT_INDEX_FILE: '/tmp/private.index',
      LC_ALL: 'C',
    });
  });
});
