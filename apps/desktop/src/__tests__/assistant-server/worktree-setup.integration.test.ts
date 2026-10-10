import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WorktreeSetupInput } from '../../assistant-server/worktree-service';
import {
  parseWorktreeInclude,
  runWorktreeSetup,
  WORKTREE_SETUP_COMBINED_OUTPUT_CAP_BYTES,
  WORKTREE_SETUP_OUTPUT_CAP_BYTES,
  worktreeSetupEnvironment,
} from '../../assistant-server/worktree-setup';

/** Mirrors the byte-hash `resolveSetupCommand` re-computes on disk. */
function sha256(scriptContent: string): string {
  return createHash('sha256').update(scriptContent, 'utf8').digest('hex');
}

describe('parseWorktreeInclude', () => {
  it('keeps one pattern per line and drops comments and blanks', () => {
    expect(
      parseWorktreeInclude('.env\n\n# a comment\n  .env.local  \nconfig/*.local.json\n')
    ).toEqual(['.env', '.env.local', 'config/*.local.json']);
  });

  it('REJECTS an absolute or escaping pattern rather than copying outside the repo', () => {
    expect(() => parseWorktreeInclude('/etc/passwd\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "/etc/passwd"'
    );
    expect(() => parseWorktreeInclude('../secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "../secrets"'
    );
    expect(() => parseWorktreeInclude('..\\secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "..\\secrets"'
    );
    expect(() => parseWorktreeInclude('C:\\secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "C:\\secrets"'
    );
  });
});

describe('worktreeSetupEnvironment', () => {
  it('exports the Conductor-idiom BRAINSTRIKE_* variables', () => {
    const env = worktreeSetupEnvironment({
      rootPath: '/work/app',
      worktreeName: 'bright-fox',
      worktreePath: '/managed/app/bright-fox',
    });
    expect(env).toMatchObject({
      BRAINSTRIKE_ROOT_PATH: '/work/app',
      BRAINSTRIKE_WORKSPACE_NAME: 'bright-fox',
      BRAINSTRIKE_WORKSPACE_PATH: '/managed/app/bright-fox',
    });
    expect(Number.parseInt(env['BRAINSTRIKE_PORT'] as string, 10)).toBeGreaterThanOrEqual(3000);
  });

  it('derives a STABLE port from the worktree path', () => {
    const once = worktreeSetupEnvironment({
      rootPath: '/r',
      worktreeName: 'a',
      worktreePath: '/m/a',
    });
    const twice = worktreeSetupEnvironment({
      rootPath: '/r',
      worktreeName: 'a',
      worktreePath: '/m/a',
    });
    expect(once['BRAINSTRIKE_PORT']).toBe(twice['BRAINSTRIKE_PORT']);
  });
});

describe('runWorktreeSetup (real fs + real processes)', () => {
  let repo: string;
  let tempRoot: string;
  let worktreePath: string;

  function baseInput(): WorktreeSetupInput {
    return {
      settings: {
        isDefaultDirectory: true,
        managedDirectory: tempRoot,
        setupCommand: null,
      },
      sourcePath: repo,
      worktree: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'main',
        branch: 'bs/bright-fox',
        createdAt: '2026-08-25T00:00:00.000Z',
        createdBy: 'user',
        id: '01993a12-0000-7000-8000-000000000013',
        path: worktreePath,
        repoCommonDir: path.join(repo, '.git'),
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      },
    };
  }

  function configuredInput(script: string): WorktreeSetupInput {
    const scriptPath = path.join(tempRoot, 'configured-setup.cjs');
    writeFileSync(scriptPath, script);
    const input = baseInput();
    return {
      ...input,
      settings: { ...input.settings, setupCommand: [process.execPath, scriptPath] },
    };
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-worktree-setup-'));
    repo = path.join(tempRoot, 'repo');
    worktreePath = path.join(tempRoot, 'bright-fox');
    mkdirSync(repo);
    mkdirSync(worktreePath);
  });

  afterEach(() => {
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('reports "none" when there is nothing to copy and nothing to run', async () => {
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome).toEqual({
      copiedPaths: [],
      output: '',
      reason: null,
      skippedCopies: [],
      status: 'none',
      truncated: false,
    });
  });

  it('copies files matched by .worktreeinclude, ignored ones included', async () => {
    writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.copiedPaths).toEqual(['.env']);
    expect(readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(outcome.status).toBe('succeeded');
  });

  it('refuses a glob match that resolves outside the repository root', async () => {
    const outside = path.join(tempRoot, 'outside-read');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'credentials'), 'host-secret\n');
    symlinkSync(outside, path.join(repo, 'hostcfg'), 'dir');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'hostcfg/credentials\n');

    const outcome = await runWorktreeSetup(baseInput());

    expect(existsSync(path.join(worktreePath, 'hostcfg', 'credentials'))).toBe(false);
    expect(outcome.skippedCopies).toEqual([
      expect.objectContaining({
        path: path.join('hostcfg', 'credentials'),
        pattern: 'hostcfg/credentials',
        reason: expect.stringContaining('outside the repository root'),
      }),
    ]);
    expect(outcome.output).toContain(path.join('hostcfg', 'credentials'));
    expect(outcome.status).toBe('succeeded');
  });

  it('refuses a copy whose existing target parent resolves outside the worktree', async () => {
    const outside = path.join(tempRoot, 'outside-write');
    mkdirSync(outside);
    mkdirSync(path.join(repo, 'evil'));
    writeFileSync(path.join(repo, 'evil', 'config.json'), '{"safe":true}\n');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'evil/config.json\n');
    symlinkSync(outside, path.join(worktreePath, 'evil'), 'dir');

    const outcome = await runWorktreeSetup(baseInput());

    expect(existsSync(path.join(outside, 'config.json'))).toBe(false);
    expect(outcome.skippedCopies).toEqual([
      expect.objectContaining({
        path: path.join('evil', 'config.json'),
        reason: expect.stringContaining('outside the worktree root'),
      }),
    ]);
    expect(outcome.output).toContain(path.join('evil', 'config.json'));
    expect(outcome.status).toBe('succeeded');
  });

  it('copies normal nested matches through the containment checks', async () => {
    mkdirSync(path.join(repo, 'config', 'nested'), { recursive: true });
    writeFileSync(path.join(repo, 'config', 'nested', 'app.json'), '{"enabled":true}\n');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'config/nested/*.json\n');

    const outcome = await runWorktreeSetup(baseInput());

    expect(outcome.copiedPaths).toEqual([path.join('config', 'nested', 'app.json')]);
    expect(readFileSync(path.join(worktreePath, 'config', 'nested', 'app.json'), 'utf8')).toBe(
      '{"enabled":true}\n'
    );
    expect(outcome.skippedCopies).toEqual([]);
  });

  it('copies an in-tree symlink as a symlink instead of dereferencing it', async () => {
    writeFileSync(path.join(repo, 'shared.env'), 'SHARED=1\n');
    symlinkSync('shared.env', path.join(repo, '.env'));
    writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');

    const outcome = await runWorktreeSetup(baseInput());

    expect(outcome.copiedPaths).toEqual(['.env']);
    expect(lstatSync(path.join(worktreePath, '.env')).isSymbolicLink()).toBe(true);
  });

  it('runs approved repository setup on POSIX or configured setup on Windows with the BRAINSTRIKE_* env', async () => {
    const script = '#!/bin/sh\necho "name=$BRAINSTRIKE_WORKSPACE_NAME"\n';
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), script);
    let outcome = await runWorktreeSetup({
      ...baseInput(),
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256(script) },
    });
    if (process.platform === 'win32') {
      expect(outcome).toMatchObject({
        output: '',
        reason: expect.stringContaining('needs a POSIX shell'),
        status: 'skipped',
      });
      // Explicit configuration is a separate authorization path from repository consent.
      outcome = await runWorktreeSetup(
        configuredInput("process.stdout.write('name=' + process.env.BRAINSTRIKE_WORKSPACE_NAME)")
      );
    }
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output).toContain('name=bright-fox');
  });

  it('fails closed to a visible skip when the standing decision is pinned to a DIFFERENT hash than what is on disk', async () => {
    const marker = path.join(tempRoot, 'must-not-exist');
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      `#!/bin/sh\necho executed > "${marker}"\n`
    );

    const outcome = await runWorktreeSetup({
      ...baseInput(),
      // Pinned to a hash that does not match the script now on disk — as if
      // the script changed (pull / branch switch / rebase) after the
      // decision was made.
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256('a different script') },
    });

    expect(existsSync(marker)).toBe(false);
    expect(outcome).toMatchObject({
      reason:
        'Repository setup script consent is required before it can run: the script changed since you last decided.',
      status: 'skipped',
    });
  });

  it('never runs a repository script before a consent decision is present', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    const marker = path.join(tempRoot, 'must-not-exist');
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      `#!/bin/sh\necho executed > "${marker}"\n`
    );

    const outcome = await runWorktreeSetup(baseInput());

    expect(existsSync(marker)).toBe(false);
    expect(outcome).toMatchObject({
      reason: 'Repository setup script consent is required before it can run.',
      status: 'skipped',
    });
  });

  it('returns a visible skipped outcome when repository setup is denied', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    const marker = path.join(tempRoot, 'must-not-exist');
    const script = `#!/bin/sh\necho executed > "${marker}"\n`;
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), script);

    const outcome = await runWorktreeSetup({
      ...baseInput(),
      repositorySetupDecision: { decision: 'denied', scriptSha256: sha256(script) },
    });

    expect(existsSync(marker)).toBe(false);
    expect(outcome).toMatchObject({
      reason: 'Repository setup script was skipped because you denied permission.',
      status: 'skipped',
    });
  });

  it('reports a FAILING script as failed WITH its output, and does not throw', async () => {
    const script = '#!/bin/sh\necho "boom" >&2\nexit 3\n';
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), script);
    let outcome = await runWorktreeSetup({
      ...baseInput(),
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256(script) },
    });
    if (process.platform === 'win32') {
      expect(outcome).toMatchObject({
        output: '',
        reason: expect.stringContaining('needs a POSIX shell'),
        status: 'skipped',
      });
      outcome = await runWorktreeSetup(
        configuredInput("process.stderr.write('boom\\n'); process.exitCode = 3")
      );
    }
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('Setup command exited with code 3.');
    expect(outcome.output).toContain('boom');
  });

  it('prefers an explicit settings setupCommand over the repository script', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), '#!/bin/sh\necho script\n');
    const outcome = await runWorktreeSetup(configuredInput("process.stdout.write('configured')"));
    expect(outcome.output).toContain('configured');
    expect(outcome.output).not.toContain('script');
  });

  it('skips setup without probing a present repository script when setup is disabled', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      '#!/bin/sh\necho must-not-run\n'
    );
    const input = baseInput();

    const outcome = await runWorktreeSetup({
      ...input,
      settings: { ...input.settings, setupCommand: 'disabled' },
    });

    expect(outcome).toMatchObject({
      output: '',
      reason: 'Setup is disabled in Settings → Workspace.',
      status: 'skipped',
    });
  });

  it('reports an empty configured setup command as skipped', async () => {
    const input = baseInput();
    const outcome = await runWorktreeSetup({
      ...input,
      settings: { ...input.settings, setupCommand: [] },
    });

    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('The configured setup command is empty.');
  });

  it('surfaces a non-ENOENT error while reading .worktreeinclude', async () => {
    mkdirSync(path.join(repo, '.worktreeinclude'));

    const outcome = await runWorktreeSetup(baseInput());

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('EISDIR');
  });

  it('surfaces a non-ENOENT error while resolving the repository setup script', async () => {
    if (process.platform === 'win32') {
      mkdirSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), { recursive: true });
    } else {
      writeFileSync(path.join(repo, '.brainstrike'), 'not a directory\n');
    }

    const outcome = await runWorktreeSetup(baseInput());

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain(process.platform === 'win32' ? 'EISDIR' : 'ENOTDIR');
  });

  it('copies included files before the setup command runs', async () => {
    mkdirSync(path.join(repo, 'config'));
    writeFileSync(path.join(repo, 'config', 'setup-token'), 'copied-before-command\n');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'config/setup-token\n');
    mkdirSync(path.join(repo, '.brainstrike'));
    const script = '#!/bin/sh\ncat config/setup-token\n';
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), script);

    let outcome = await runWorktreeSetup({
      ...baseInput(),
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256(script) },
    });
    if (process.platform === 'win32') {
      expect(outcome).toMatchObject({
        output: '',
        reason: expect.stringContaining('needs a POSIX shell'),
        status: 'skipped',
      });
      // The refused repository invocation already copied it; prove this invocation copies too.
      rmSync(path.join(worktreePath, 'config', 'setup-token'));
      expect(existsSync(path.join(worktreePath, 'config', 'setup-token'))).toBe(false);
      outcome = await runWorktreeSetup(
        configuredInput(
          "process.stdout.write(require('node:fs').readFileSync('config/setup-token'))"
        )
      );
    }

    expect(outcome.status).toBe('succeeded');
    expect(outcome.output).toContain('copied-before-command');
  });

  it('truncates oversized output and SAYS it truncated', async () => {
    const script = '#!/bin/sh\nfor i in $(seq 1 4000); do echo "0123456789"; done\n';
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), script);
    let outcome = await runWorktreeSetup({
      ...baseInput(),
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256(script) },
    });
    if (process.platform === 'win32') {
      expect(outcome).toMatchObject({
        output: '',
        reason: expect.stringContaining('needs a POSIX shell'),
        status: 'skipped',
      });
      outcome = await runWorktreeSetup(
        configuredInput("process.stdout.write('0123456789\\n'.repeat(4000))")
      );
    }
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(
      WORKTREE_SETUP_OUTPUT_CAP_BYTES
    );
  });

  it('lets a command producing more than 128 KiB finish with truncated output', async () => {
    const input = baseInput();
    const outcome = await runWorktreeSetup({
      ...input,
      settings: {
        ...input.settings,
        setupCommand: [process.execPath, '-e', "process.stdout.write('x'.repeat(600_000))"],
      },
    });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(
      WORKTREE_SETUP_OUTPUT_CAP_BYTES
    );
  });

  it('retains bounded stderr even when stdout exceeds its independent cap', async () => {
    const input = baseInput();
    const outcome = await runWorktreeSetup({
      ...input,
      settings: {
        ...input.settings,
        setupCommand: [
          process.execPath,
          '-e',
          "process.stdout.write('o'.repeat(20_000)); process.stderr.write('stderr-tail')",
        ],
      },
    });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.truncated).toBe(true);
    expect(outcome.output).toContain('stderr-tail');
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(
      WORKTREE_SETUP_COMBINED_OUTPUT_CAP_BYTES
    );
  });

  it('kills a setup command after an injected short timeout', async () => {
    const input = baseInput();
    const startedAt = Date.now();
    const outcome = await runWorktreeSetup({
      ...input,
      settings: {
        ...input.settings,
        setupCommand: [process.execPath, '-e', 'setTimeout(() => {}, 5_000)'],
      },
      timeoutMs: 100,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('timed out after 0.1s');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it.skipIf(process.platform === 'win32')(
    'settles at the timeout and kills a grandchild that inherited the output pipes',
    async () => {
      const pidPath = path.join(tempRoot, 'grandchild.pid');
      const input = baseInput();
      const originalSetTimeout = globalThis.setTimeout;
      let armTimeout: (() => void) | undefined;
      const deferredTimeout = {
        unref: () => deferredTimeout,
      } as ReturnType<typeof setTimeout>;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      setTimeoutSpy.mockImplementationOnce((callback, delay, ...args) => {
        armTimeout = () => {
          originalSetTimeout(callback, delay, ...args);
        };
        return deferredTimeout;
      });
      const pidPublished = new Promise<void>((resolve, reject) => {
        const watcher = watch(tempRoot, (_event, filename) => {
          if (filename === path.basename(pidPath)) {
            watcher.close();
            resolve();
          }
        });
        watcher.once('error', reject);
        onTestFinished(() => watcher.close());
      });
      onTestFinished(() => {
        setTimeoutSpy.mockRestore();
      });
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => { fs.closeSync(1); fs.closeSync(2); });",
        'fs.writeFileSync(process.argv[1], String(process.pid));',
        'setInterval(() => {}, 30_000);',
      ].join(' ');
      const script = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}, process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        'child.unref();',
        'setInterval(() => {}, 30_000);',
      ].join(' ');
      const startedAt = Date.now();

      const outcomePromise = runWorktreeSetup({
        ...input,
        settings: {
          ...input.settings,
          setupCommand: [process.execPath, '-e', script, pidPath],
        },
        terminationGraceMs: 100,
        timeoutMs: 150,
      });
      await pidPublished;
      if (armTimeout === undefined) {
        throw new Error('The worktree setup timeout was not scheduled.');
      }
      armTimeout();
      const outcome = await outcomePromise;

      const grandchildPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
      onTestFinished(() => {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.reason).toBe('Setup command timed out after 0.15s.');
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(() => process.kill(grandchildPid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' })
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when a setup command ignores SIGTERM',
    async () => {
      const pidPath = path.join(tempRoot, 'term-ignoring.pid');
      const input = baseInput();
      const startedAt = Date.now();

      const outcome = await runWorktreeSetup({
        ...input,
        settings: {
          ...input.settings,
          setupCommand: [
            '/bin/sh',
            '-c',
            'trap "" TERM; echo $$ > "$1"; while :; do sleep 30; done',
            'setup-command',
            pidPath,
          ],
        },
        terminationGraceMs: 100,
        timeoutMs: 150,
      });

      const commandPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
      expect(outcome.status).toBe('failed');
      expect(outcome.reason).toBe('Setup command timed out after 0.15s.');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(() => process.kill(commandPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }
  );

  it('refuses entries that would exceed the total copy budget after earlier copies', async () => {
    writeFileSync(path.join(repo, 'first.bin'), '12345678');
    writeFileSync(path.join(repo, 'second.bin'), 'abcdefghijkl');
    writeFileSync(path.join(repo, '.worktreeinclude'), 'first.bin\nsecond.bin\n');

    const outcome = await runWorktreeSetup({ ...baseInput(), copyMaxBytes: 15 });

    expect(readFileSync(path.join(worktreePath, 'first.bin'), 'utf8')).toBe('12345678');
    expect(existsSync(path.join(worktreePath, 'second.bin'))).toBe(false);
    expect(outcome.copiedPaths).toEqual(['first.bin']);
    expect(outcome.skippedCopies).toEqual([
      expect.objectContaining({
        path: 'second.bin',
        reason: expect.stringContaining('copy budget'),
      }),
    ]);
    expect(outcome.status).toBe('succeeded');
  });
});
