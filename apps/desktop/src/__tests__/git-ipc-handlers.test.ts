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

const windowsRunMock = vi.hoisted(() =>
  vi.fn(async (_options: Record<string, unknown>) => ({
    exitCode: 0,
    stderr: '',
    stdout: '',
    timedOut: false,
  }))
);

vi.mock('../git-command-windows', () => ({ runWindowsGitCommand: windowsRunMock }));

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
  windowsRunMock.mockClear();
});

describe('execFileGitRunner', () => {
  it('keeps unpinned command env while pinned safety keys win over overrides', async () => {
    await execFileGitRunner({
      args: ['status'],
      cwd: '/worktree',
      env: { GIT_INDEX_FILE: '/tmp/private.index', GIT_TERMINAL_PROMPT: '1' },
      timeoutMs: 5000,
    });

    const windows = process.platform === 'win32';
    expect(windows ? windowsRunMock : execFileMock).toHaveBeenCalledTimes(1);
    const options = windows ? windowsRunMock.mock.calls[0]?.[0] : execFileMock.mock.calls[0]?.[2];
    expect(options?.['env']).toMatchObject({
      GIT_INDEX_FILE: '/tmp/private.index',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    });
  });
});
