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
  createPinnedGitEnvironment,
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
  return { calls, runner };
}

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

describe('git IPC handlers — root resolution + containment', () => {
  it('rejects a missing/empty rootId without running git', async () => {
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stderr: '',
      stdout: '',
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
      stderr: '',
      stdout: '',
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
      stderr: '',
      stdout: '# branch.head main\n',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.status('r1');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cwd).toBe(dir);
    // Scoped to the opened root ('-- .') for subdir-of-worktree containment.
    expect(calls[0]?.args).toEqual([
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z',
      '--',
      '.',
    ]);
    expect(calls[1]?.args).toEqual(['rev-parse', '--show-prefix']);
  });

  it('reports a clean error when the resolved root no longer exists on disk', async () => {
    const dir = await makeDir();
    const missing = path.join(dir, 'gone');
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stderr: '',
      stdout: '',
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
      stderr: '',
      stdout: '',
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
    const responses = [
      { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: '\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'origin\n', timedOut: false },
      {
        exitCode: 128,
        stderr: 'fatal: could not read Username for https://example.com: terminal prompts disabled',
        stdout: '',
        timedOut: false,
      },
    ];
    let index = 0;
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: ({ args, cwd }) => {
        calls.push({ args, cwd });
        const response = responses[index] ?? responses.at(-1);
        index += 1;
        return Promise.resolve(response ?? responses[3]);
      },
    });

    const result = await handlers.push('r1', { remote: 'origin' });
    // Push first probes the upstream. With none configured, it validates the
    // renderer-selected remote before setting it as the upstream.
    expect(calls).toHaveLength(4);
    expect(calls[0]?.args).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(calls[1]?.args).toEqual([
      'for-each-ref',
      '--format=%(upstream:short)',
      'refs/heads/main',
    ]);
    expect(calls[2]?.args).toEqual(['remote']);
    expect(calls[3]?.args).toEqual(['push', '-u', '--', 'origin', 'HEAD']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/could not read Username|terminal prompts disabled/);
    }
  });

  it('uses a bare `git push` when the branch already has an upstream', async () => {
    const dir = await makeDir();
    // Per-call responses: current branch, upstream, then push.
    const responses = [
      { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'origin/main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'Everything up-to-date\n', timedOut: false },
    ];
    let index = 0;
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: ({ args, cwd }) => {
        calls.push({ args, cwd });
        const response = responses[index] ?? responses.at(-1);
        index += 1;
        return Promise.resolve({
          exitCode: response?.exitCode ?? 0,
          stderr: response?.stderr ?? '',
          stdout: response?.stdout ?? '',
          timedOut: false,
        });
      },
    });

    const result = await handlers.push('r1');
    expect(calls).toHaveLength(3);
    expect(calls[2]?.args).toEqual(['push']);
    expect(result.ok).toBe(true);
  });

  it('builds the pull command and returns the output on success', async () => {
    const dir = await makeDir();
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: ({ args, cwd }) => {
        calls.push({ args, cwd });
        return Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout: args[0] === 'rev-parse' ? `${dir}\n` : 'Already up to date.\n',
          timedOut: false,
        });
      },
    });

    const result = await handlers.pull('r1');
    expect(calls.map((call) => call.args)).toEqual([
      ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      ['pull'],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toContain('Already up to date');
    }
  });

  it('maps a timed-out push to a structured timeout error', async () => {
    const dir = await makeDir();
    const responses = [
      { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'origin/main\n', timedOut: false },
      {
        exitCode: null,
        failureReason: 'timeout' as const,
        stderr: '',
        stdout: '',
        timedOut: true,
      },
    ];
    let index = 0;
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: () => {
        const response = responses[index] ?? responses.at(-1);
        index += 1;
        return Promise.resolve(response ?? responses[2]);
      },
    });

    const result = await handlers.push('r1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/timed out/);
    }
  });
});

describe('git IPC handlers — commit arg construction (no shell)', () => {
  it('passes summary and description as separate literal -m arguments', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stderr: '',
      stdout: 'abc1234',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const evil = 'msg; rm -rf / $(touch x)';
    await handlers.commit('r1', { description: 'Detailed body.', summary: evil });
    const commitCall = calls.find((c) => c.args[0] === 'commit');
    expect(commitCall?.args).toEqual(['commit', '-m', evil, '-m', 'Detailed body.']);
  });
});

describe('git IPC runner — pinned repository environment', () => {
  it('removes routing overrides case-insensitively while preserving audited Git controls', () => {
    const environment = createPinnedGitEnvironment({
      GIT_ALLOW_PROTOCOL: 'https:ssh',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/outside/objects',
      GIT_ASKPASS: '/usr/local/bin/git-askpass',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_AUTHOR_NAME: 'Explicit Author',
      GIT_COMMON_DIR: '/outside/common',
      GIT_CONFIG: '/outside/config',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/outside/hooks',
      GIT_DIR: '/outside/repository',
      GIT_GRAFT_FILE: '/outside/grafts',
      GIT_INDEX_FILE: '/outside/index',
      GIT_LFS_SKIP_PUSH: '1',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_REPLACE_REF_BASE: 'refs/replace-elsewhere/',
      GIT_SHALLOW_FILE: '/outside/shallow',
      GIT_SSH_COMMAND: 'ssh -F /outside/config',
      GIT_WORK_TREE: '/outside/worktree',
      Git_Config: '/outside/mixed-case-config',
      git_dir: '/outside/mixed-case-repository',
      HOME: '/Users/example',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });

    expect(environment).toMatchObject({
      GIT_ALLOW_PROTOCOL: 'https:ssh',
      GIT_ASKPASS: '/usr/local/bin/git-askpass',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_AUTHOR_NAME: 'Explicit Author',
      GIT_LFS_SKIP_PUSH: '1',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_SSH_COMMAND: 'ssh -F /outside/config',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/Users/example',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GIT_WORK_TREE).toBeUndefined();
    expect(environment.GIT_COMMON_DIR).toBeUndefined();
    expect(environment.GIT_INDEX_FILE).toBeUndefined();
    expect(environment.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(environment.GIT_CONFIG).toBeUndefined();
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined();
    expect(environment.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(environment.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(environment.GIT_GRAFT_FILE).toBeUndefined();
    expect(environment.GIT_REPLACE_REF_BASE).toBeUndefined();
    expect(environment.GIT_SHALLOW_FILE).toBeUndefined();
    expect(environment.Git_Config).toBeUndefined();
    expect(environment.git_dir).toBeUndefined();
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
