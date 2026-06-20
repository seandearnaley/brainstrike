/**
 * Coverage for the git IPC handler layer: rootId resolution + containment, and
 * structured-error behavior. Push/pull are tested WITHOUT a network by injecting
 * a fake runner and asserting the exact git argument array (the command
 * construction) plus the structured error mapping — never a real push.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitCommandRun, GitCommandRunner } from '../assistant-server/git-service';
import {
  createGitIpcHandlers,
  execFileGitRunner,
  type WorkspaceRootResolver,
} from '../git-ipc-handlers';

const createdDirs: string[] = [];

async function makeDir(prefix = 'brainstrike-git-ipc-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

function fakeResolver(
  roots: { displayName: string; path: string; rootId: string }[]
): WorkspaceRootResolver {
  return { listRoots: () => Promise.resolve(roots) };
}

/** A runner that records the args it was called with and returns a canned run. */
function recordingRunner(canned: GitCommandRun): {
  runner: GitCommandRunner;
  calls: { args: readonly string[]; cwd: string }[];
} {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const runner: GitCommandRunner = ({ args, cwd }) => {
    calls.push({ args, cwd });
    return Promise.resolve(canned);
  };
  return { runner, calls };
}

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('git IPC handlers — root resolution + containment', () => {
  it('rejects a missing/empty rootId without running git', async () => {
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({ resolver: fakeResolver([]), run: runner });

    const empty = await handlers.status('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toMatch(/non-empty rootId/);
    }
    const nonString = await handlers.status(42);
    expect(nonString.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects a rootId that matches no open folder (no arbitrary cwd)', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'known', path: dir, rootId: 'known-id' }]),
      run: runner,
    });

    const result = await handlers.status('unknown-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No open folder matches root id/);
    }
    expect(calls).toHaveLength(0);
  });

  it('runs git with cwd pinned to the resolved root path', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: '# branch.head main\n',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.status('r1');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(dir);
    // Scoped to the opened root ('-- .') for subdir-of-worktree containment.
    expect(calls[0]?.args).toEqual(['status', '--porcelain=v2', '--branch', '--', '.']);
  });

  it('reports a clean error when the resolved root no longer exists on disk', async () => {
    const dir = await makeDir();
    const missing = path.join(dir, 'gone');
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'gone', path: missing, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.status('r1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no longer exists/);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a root with no local filesystem path (web/FSA root)', async () => {
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'web', path: 'not-absolute', rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.status('r1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no local filesystem path/);
    }
    expect(calls).toHaveLength(0);
  });

  it('surfaces a resolver failure as a structured error', async () => {
    const failingResolver: WorkspaceRootResolver = {
      listRoots: () => Promise.reject(new Error('db down')),
    };
    const handlers = createGitIpcHandlers({ resolver: failingResolver });
    const result = await handlers.status('r1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unavailable/);
    }
  });
});

describe('git IPC handlers — push/pull command construction (no network)', () => {
  it('builds the push command and maps a network failure to a structured error', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: could not read Username for https://example.com: terminal prompts disabled',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.push('r1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['push']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/could not read Username|terminal prompts disabled/);
    }
  });

  it('builds the pull command and returns the output on success', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: 'Already up to date.\n',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.pull('r1');
    expect(calls[0]?.args).toEqual(['pull']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toContain('Already up to date');
    }
  });

  it('maps a timed-out push to a structured timeout error', async () => {
    const dir = await makeDir();
    const { runner } = recordingRunner({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      failureReason: 'timeout',
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.push('r1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/timed out/);
    }
  });
});

describe('git IPC handlers — commit arg construction (no shell)', () => {
  it('passes the commit message as a single -m argument (no shell interpolation)', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stdout: 'abc1234',
      stderr: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const evil = 'msg; rm -rf / $(touch x)';
    await handlers.commit('r1', { message: evil });
    // The commit invocation passes the message verbatim as one arg after -m.
    const commitCall = calls.find((c) => c.args[0] === 'commit');
    expect(commitCall?.args).toEqual(['commit', '-m', evil]);
  });
});

describe('execFileGitRunner — errno discrimination (real runner)', () => {
  it('maps an ENOENT spawn failure to failureReason "notFound"', async () => {
    // A non-existent cwd makes execFile fail to spawn with ENOENT — the same
    // errno a missing `git` binary yields — so the runner sets 'notFound'.
    const run = await execFileGitRunner({
      args: ['status'],
      cwd: '/no/such/directory/anywhere',
      timeoutMs: 5000,
    });
    expect(run.failureReason).toBe('notFound');
    expect(run.exitCode).toBeNull();
    expect(run.timedOut).toBe(false);
  });
});
