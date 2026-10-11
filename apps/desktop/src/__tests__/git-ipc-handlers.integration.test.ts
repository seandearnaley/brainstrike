/**
 * Coverage for the git IPC handler layer: rootId resolution + containment, and
 * structured-error behavior. Push/pull are tested WITHOUT a network by injecting
 * a fake runner and asserting the exact git argument array (the command
 * construction) plus the structured error mapping — never a real push.
 */
import { execFile } from 'node:child_process';
import './assistant-server/_windows-command-fixture';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitCommandRun, GitCommandRunner } from '../assistant-server/git-service';
import {
  createGitIpcHandlers,
  createPinnedGitEnvironment,
  execFileGitRunner,
  type WorkspaceRootResolver,
} from '../git-ipc-handlers';

const execFileAsync = promisify(execFile);

const createdDirs: string[] = [];

async function makeDir(prefix = 'brainstrike-git-ipc-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

/** Real temp git repo (git init + local user) for exercising the production runner. */
async function makeRepo(prefix = 'brainstrike-git-ipc-repo-'): Promise<string> {
  const real = await makeDir(prefix);
  await execFileAsync('git', ['init', '-q'], { cwd: real });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: real });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: real });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: real });
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
    if (args[0] === 'config') {
      return Promise.resolve({ ...canned, exitCode: 1, stdout: '' });
    }
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
      '-c',
      'core.fsmonitor=false',
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
    const responses: GitCommandRun[] = [
      { exitCode: 0, stderr: '', stdout: `${dir}\n`, timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: '\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'origin\n', timedOut: false },
      { exitCode: 1, stderr: '', stdout: '', timedOut: false },
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
        if (!response) {
          throw new Error('Expected a canned git command response.');
        }
        return Promise.resolve(response);
      },
    });

    const result = await handlers.push('r1', { remote: 'origin' });
    // Push first verifies that the authorized root is the full worktree. It
    // then probes the upstream and validates the renderer-selected remote.
    expect(calls).toHaveLength(6);
    expect(calls[0]?.args).toEqual(['rev-parse', '--path-format=absolute', '--show-toplevel']);
    expect(calls[1]?.args).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    expect(calls[2]?.args).toEqual([
      'for-each-ref',
      '--format=%(upstream:short)',
      'refs/heads/main',
    ]);
    expect(calls[3]?.args).toEqual(['remote']);
    expect(calls[4]?.args[0]).toBe('config');
    expect(calls[5]?.args).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '-u',
      '--',
      'origin',
      'HEAD',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/could not read Username|terminal prompts disabled/);
    }
  });

  it('uses a bare `git push` when the branch already has an upstream', async () => {
    const dir = await makeDir();
    // Per-call responses: full-root probe, current branch, upstream, then push.
    const responses: GitCommandRun[] = [
      { exitCode: 0, stderr: '', stdout: `${dir}\n`, timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'origin/main\n', timedOut: false },
      { exitCode: 1, stderr: '', stdout: '', timedOut: false },
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
    expect(calls).toHaveLength(5);
    expect(calls[4]?.args).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
    ]);
    expect(result.ok).toBe(true);
  });

  it('builds the pull command and returns the output on success', async () => {
    const dir = await makeDir();
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: ({ args, cwd }) => {
        calls.push({ args, cwd });
        if (args[0] === 'config') {
          return Promise.resolve({ exitCode: 1, stderr: '', stdout: '', timedOut: false });
        }
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
      ['config', '--null', '--name-only', '--get-regexp', '^hook\\..*\\.command$'],
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'pull'],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toContain('Already up to date');
    }
  });

  it('maps a timed-out push to a structured timeout error', async () => {
    const dir = await makeDir();
    const responses = [
      { exitCode: 0, stderr: '', stdout: `${dir}\n`, timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'main\n', timedOut: false },
      { exitCode: 0, stderr: '', stdout: 'origin/main\n', timedOut: false },
      { exitCode: 1, stderr: '', stdout: '', timedOut: false },
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
        if (!response) {
          throw new Error('Expected a canned git command response.');
        }
        return Promise.resolve(response);
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
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const runner: GitCommandRunner = ({ args, cwd }) => {
      calls.push({ args, cwd });
      return Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: args[0] === 'config' ? 'hook.sentinel.command\0' : 'abc1234',
        timedOut: false,
      });
    };
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const evil = 'msg; rm -rf / $(touch x)';
    await handlers.commit('r1', { description: 'Detailed body.', summary: evil });
    const commitCall = calls.find((c) => c.args.includes('commit'));
    expect(commitCall?.args).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'hook.sentinel.enabled=false',
      'commit',
      '-m',
      evil,
      '-m',
      'Detailed body.',
    ]);
  });
});

describe('git IPC handlers — structuredFileDiff (fake runner, arg + cwd passthrough)', () => {
  it('routes params through to the service unmodified and pins every invocation to the resolved cwd', async () => {
    const dir = await makeDir();
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const runner: GitCommandRunner = ({ args, binaryStdout, cwd }) => {
      calls.push({ args, cwd });
      if (args[0] === 'config') {
        return Promise.resolve({ exitCode: 1, stderr: '', stdout: '', timedOut: false });
      }
      if (args.includes('diff') && args.includes('--numstat')) {
        return Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout: '1\t1\tfile.txt\0',
          timedOut: false,
        });
      }
      if (args.includes('cat-file')) {
        const spec = args.at(-1) ?? '';
        const content = spec.startsWith('HEAD:') ? 'old\n' : 'new\n';
        if (args.includes('-s')) {
          // Size probe (fix B): plain decimal text, never `binaryStdout`.
          return Promise.resolve({
            exitCode: 0,
            stderr: '',
            stdout: `${Buffer.byteLength(content, 'utf8')}\n`,
            timedOut: false,
          });
        }
        return binaryStdout
          ? Promise.resolve({
              exitCode: 0,
              stderr: '',
              stdout: '',
              stdoutBuffer: Buffer.from(content, 'utf8'),
              timedOut: false,
            })
          : Promise.resolve({ exitCode: 0, stderr: '', stdout: content, timedOut: false });
      }
      if (args.includes('diff')) {
        return Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout:
            'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
          timedOut: false,
        });
      }
      return Promise.resolve({ exitCode: 0, stderr: '', stdout: '', timedOut: false });
    };
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.structuredFileDiff('r1', { mode: 'staged', path: 'file.txt' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('modified');
      expect(result.value.content).toEqual({
        kind: 'full',
        newContent: 'new\n',
        oldContent: 'old\n',
      });
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.cwd).toBe(dir);
    }
    // The `HEAD:./<path>` cat-file spec proves `path` flowed through the
    // handler unmodified (the `./` magic pathspec form resolves against cwd —
    // see `git-structured-diff.ts`'s module doc comment). (The numstat call
    // is deliberately root-scoped `-- .` — see `resolveNumstatEntry`'s doc
    // comment — and is invariant to `path`, so asserting on IT would prove
    // nothing about passthrough.)
    const catFileCall = calls.find(
      (call) => call.args.includes('cat-file') && call.args.at(-1)?.startsWith('HEAD:')
    );
    expect(catFileCall?.args.at(-1)).toBe('HEAD:./file.txt');
  });

  it('rejects an unknown params shape without reaching the service (unsupported keys)', async () => {
    const dir = await makeDir();
    const { runner, calls } = recordingRunner({
      exitCode: 0,
      stderr: '',
      stdout: '',
      timedOut: false,
    });
    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: dir, rootId: 'r1' }]),
      run: runner,
    });

    const result = await handlers.structuredFileDiff('r1', {
      extra: 'nope',
      mode: 'staged',
      path: 'file.txt',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // BST-1113 widened this engine to `commit`/`range`, so the allowed-key set
      // is now per-mode and the message names the mode it rejected for. The
      // assertion stays specific: it must still say the params were REJECTED and
      // must name the offending key, never just fail opaquely.
      expect(result.error).toMatch(/does not accept|unsupported|only accepts/);
      expect(result.error).toContain('extra');
    }
    // Validation rejects the malformed params before any git invocation.
    expect(calls).toHaveLength(0);
  });
});

describe('git IPC handlers — structuredFileDiff (real repo, happy path)', () => {
  it('working mode: reports a real modification through the full handler stack', async () => {
    const repo = await makeRepo();
    await fsPromises.writeFile(path.join(repo, 'a.txt'), 'line1\nline2\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await fsPromises.writeFile(path.join(repo, 'a.txt'), 'line1\nline2-edited\n', 'utf8');

    const handlers = createGitIpcHandlers({
      resolver: fakeResolver([{ displayName: 'repo', path: repo, rootId: 'r1' }]),
    });

    const result = await handlers.structuredFileDiff('r1', { mode: 'working', path: 'a.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('modified');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\n',
      oldContent: 'line1\nline2\n',
    });
    expect(result.value.hunks).toEqual([{ newLines: 2, newStart: 1, oldLines: 2, oldStart: 1 }]);
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
      GIT_LITERAL_PATHSPECS: '0',
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
      GIT_LITERAL_PATHSPECS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_SSH_COMMAND: 'ssh -F /outside/config',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/Users/example',
      // Pinned so git's stderr wording stays stable for the structured-diff
      // engine's programmatic parsing (absent-classification, unmerged
      // detection, `isNotARepository`) regardless of the host OS locale.
      LANG: 'C',
      LC_ALL: 'C',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(environment['GIT_DIR']).toBeUndefined();
    expect(environment['GIT_WORK_TREE']).toBeUndefined();
    expect(environment['GIT_COMMON_DIR']).toBeUndefined();
    expect(environment['GIT_INDEX_FILE']).toBeUndefined();
    expect(environment['GIT_ALTERNATE_OBJECT_DIRECTORIES']).toBeUndefined();
    expect(environment['GIT_CONFIG']).toBeUndefined();
    expect(environment['GIT_CONFIG_COUNT']).toBeUndefined();
    expect(environment['GIT_CONFIG_KEY_0']).toBeUndefined();
    expect(environment['GIT_CONFIG_VALUE_0']).toBeUndefined();
    expect(environment['GIT_GRAFT_FILE']).toBeUndefined();
    expect(environment['GIT_REPLACE_REF_BASE']).toBeUndefined();
    expect(environment['GIT_SHALLOW_FILE']).toBeUndefined();
    expect(environment['Git_Config']).toBeUndefined();
    expect(environment['git_dir']).toBeUndefined();
  });

  it('lets a per-command ordinary identity override win over the inherited environment', async () => {
    const repo = await makeRepo();
    const originalName = process.env['GIT_AUTHOR_NAME'];
    process.env['GIT_AUTHOR_NAME'] = 'Ambient Author';
    try {
      const run = await execFileGitRunner({
        args: ['var', 'GIT_AUTHOR_IDENT'],
        cwd: repo,
        env: {
          GIT_AUTHOR_EMAIL: 'override@brainstrike.local',
          GIT_AUTHOR_NAME: 'Override Author',
        },
        timeoutMs: 5000,
      });

      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('Override Author <override@brainstrike.local>');
      expect(run.stdout).not.toContain('Ambient Author');
    } finally {
      if (originalName === undefined) {
        Reflect.deleteProperty(process.env, 'GIT_AUTHOR_NAME');
      } else {
        process.env['GIT_AUTHOR_NAME'] = originalName;
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    're-applies safety-pinned values after caller environment overrides',
    async () => {
      const repo = await makeRepo();
      const run = await execFileGitRunner({
        args: ['-c', 'alias.print-env=!env', 'print-env'],
        cwd: repo,
        env: {
          GIT_LITERAL_PATHSPECS: '0',
          GIT_TERMINAL_PROMPT: '1',
          LC_ALL: 'caller-locale',
        },
        timeoutMs: 5000,
      });

      expect(run.exitCode).toBe(0);
      const environment = new Map(
        run.stdout
          .trim()
          .split('\n')
          .map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)] as const;
          })
      );
      expect(environment.get('GIT_TERMINAL_PROMPT')).toBe('0');
      expect(environment.get('GIT_LITERAL_PATHSPECS')).toBe('1');
      expect(environment.get('LC_ALL')).toBe('C');
    }
  );
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

describe('execFileGitRunner — binary stdout (real runner)', () => {
  it('captures exact bytes via stdoutBuffer when binaryStdout is true, never a lossy decode', async () => {
    const repo = await makeRepo();
    const blobBytes = Buffer.from([0x61, 0x00, 0x62]);
    await fsPromises.writeFile(path.join(repo, 'bin.dat'), blobBytes);
    await execFileAsync('git', ['add', 'bin.dat'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'add binary blob'], { cwd: repo });

    const run = await execFileGitRunner({
      args: ['cat-file', 'blob', 'HEAD:bin.dat'],
      binaryStdout: true,
      cwd: repo,
      timeoutMs: 5000,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stdoutBuffer).toBeInstanceOf(Buffer);
    expect(run.stdoutBuffer).toEqual(blobBytes);
  });

  it("keeps today's text behavior when binaryStdout is absent", async () => {
    const repo = await makeRepo();
    await fsPromises.writeFile(path.join(repo, 'text.txt'), 'hello\n', 'utf8');
    await execFileAsync('git', ['add', 'text.txt'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'add text file'], { cwd: repo });

    const run = await execFileGitRunner({
      args: ['rev-parse', 'HEAD'],
      cwd: repo,
      timeoutMs: 5000,
    });

    expect(run.exitCode).toBe(0);
    expect(typeof run.stdout).toBe('string');
    expect(run.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(run.stdoutBuffer).toBeUndefined();
  });

  it('returns an empty stdoutBuffer and text stderr on a binary-mode failure (missing path)', async () => {
    const repo = await makeRepo();
    await fsPromises.writeFile(path.join(repo, 'text.txt'), 'hello\n', 'utf8');
    await execFileAsync('git', ['add', 'text.txt'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'add text file'], { cwd: repo });

    const run = await execFileGitRunner({
      args: ['cat-file', 'blob', 'HEAD:missing'],
      binaryStdout: true,
      cwd: repo,
      timeoutMs: 5000,
    });

    expect(run.exitCode).toBe(128);
    // `encoding: 'buffer'` makes BOTH streams Buffers; guards the `stderr:
    // stderr.toString('utf8')` conversion against ever regressing to
    // '[object Object]' from an un-decoded Buffer.
    expect(run.stderr).toMatch(/fatal:/);
    expect(run.stdoutBuffer).toBeInstanceOf(Buffer);
    expect(run.stdoutBuffer).toEqual(Buffer.alloc(0));
  });
});
