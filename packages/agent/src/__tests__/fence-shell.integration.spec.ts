/**
 * REAL OS-fence tests for shell commands (BST-2327, BST-2328).
 *
 * They spawn real sandboxed shells through `@anthropic-ai/sandbox-runtime`, so
 * they live in the uncached integration lane and skip, loudly, on a host that
 * cannot fence (see fixtures/fence-host-gate.ts).
 *
 * No assertion here needs the internet: a connection the fence refuses is
 * answered by srt's own proxy (`403`, and a violation srt attributes to the
 * command), which a dead network cannot imitate.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CodeExecutor } from '../code-execution';
import { createFenceExecutor } from '../fence/fence-executor';
import { createFencedShell, type FencedShell } from '../fence/fence-shell';
import {
  describeFenceHostSkipReason,
  refuseToSkipInAPromisedLane,
} from './fixtures/fence-host-gate';

const skipReason = refuseToSkipInAPromisedLane(
  'fence-shell.integration',
  (await describeFenceHostSkipReason()) ??
    (existsSync('/bin/sh') ? undefined : 'no /bin/sh to run commands with')
);
if (skipReason) {
  console.warn(`[fence-shell.integration] SKIPPED — ${skipReason}`);
}

interface ShellOutcome {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

describe.skipIf(skipReason !== undefined)('shell commands inside the real OS fence', () => {
  let fencedShell: FencedShell;
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bst-fence-shell-root-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'bst-fence-shell-outside-')));
    fencedShell = createFencedShell({}) as FencedShell;
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  });

  /** Spawns asynchronously: srt's proxy answers on this process's event loop. */
  const run = async (command: string): Promise<ShellOutcome> => {
    const fenced = await fencedShell.wrap({
      command,
      cwd: root,
      root,
      shell: '/bin/sh',
      signal: new AbortController().signal,
    });
    const child = spawn(fenced.executable, [...fenced.args], {
      cwd: root,
      env: { ...process.env, ...fenced.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
    fenced.release();
    return { exitCode, stderr: fenced.annotate(stderr), stdout };
  };

  it('writes inside its open folder and the sandbox temp folder', async () => {
    const result = await run(
      'printf ok > inside.txt && printf tmp > "$TMPDIR/bst-fence-shell" && cat inside.txt'
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok' });
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('ok');
  });

  it('gives each command its own temp folder, gone once the command is', async () => {
    const first = (await run('printf %s "$TMPDIR"')).stdout;
    const second = (await run('printf %s "$TMPDIR"')).stdout;
    expect(first).not.toBe(second);
    await expect.poll(() => existsSync(first) || existsSync(second)).toBe(false);
  });

  it('refuses a write outside its open folder', async () => {
    const target = join(outside, 'escaped.txt');
    const result = await run(`printf no > '${target}'`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a connection, and says the fence did', async () => {
    const result = await run(
      'curl -sS -m 10 -o /dev/null https://example.com || echo "curl exited $?"'
    );
    expect(result.stdout).toContain('curl exited');
    expect(result.stderr).toContain('403');
    expect(result.stderr).toContain('<sandbox_violations>');
    expect(result.stderr).toContain('example.com');
  });

  describe('beside a run_python call that was granted a domain', () => {
    let executor: CodeExecutor;
    let scratch: string;

    beforeAll(async () => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bst-fence-shell-python-')));
      executor = await createFenceExecutor({
        interpreters: { bash: { command: '/bin/sh', scriptExtension: 'sh' } },
      });
      // The shell's first wrap runs the readiness probe, which waits for a
      // running run_python call; warm it so the proof below runs beside one.
      await run('true');
    });

    afterAll(async () => {
      await executor?.dispose();
      rmSync(scratch, { force: true, recursive: true });
    });

    it('cannot reach that domain while the run holds its grant', async () => {
      const granted = executor.execute({
        code: `printf started > '${join(scratch, 'started')}'; sleep 5`,
        language: 'bash',
        maxOutputBytes: 4096,
        policy: { allowedDomains: ['example.com'], allowWrite: [scratch] },
        scratchDir: scratch,
        signal: new AbortController().signal,
        timeoutMs: 20_000,
      });
      let settled = false;
      void granted.finally(() => {
        settled = true;
      });
      // The grant is registered once the run's process is spawned.
      while (!existsSync(join(scratch, 'started'))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const result = await run(
        'curl -sS -m 10 -o /dev/null https://example.com || echo "curl exited $?"'
      );
      expect(settled).toBe(false);
      expect(result.stderr).toContain('403');
      expect(result.stderr).toContain('host is not on the allow list');
      await expect(granted).resolves.toMatchObject({ exitCode: 0 });
    });
  });
});
