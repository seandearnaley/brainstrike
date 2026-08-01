/**
 * REAL OS-fence tests for the FenceExecutor (BST-1062).
 *
 * These spawn actual sandboxed processes through
 * `@anthropic-ai/sandbox-runtime` — Seatbelt on macOS, bubblewrap on Linux —
 * so they live in the uncached integration lane (see
 * vitest.integration.config.mts). They are the correctness tests for the
 * isolation itself: if the fence stops denying, these fail.
 *
 * The suite refuses to pretend: when the host cannot provide an OS fence it
 * skips with a message naming exactly what is missing (platform, srt
 * dependency, or interpreter) rather than asserting a weaker property.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CodeExecutor, ExecPolicy } from '../code-execution';
import { createFenceExecutor, FENCE_MAX_STREAM_BYTES } from '../fence/fence-executor';

function resolvePython(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    try {
      const resolved = execFileSync(platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
      })
        .split('\n')[0]
        ?.trim();
      if (resolved && existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Not on PATH — try the next candidate.
    }
  }
  return;
}

const pythonPath = resolvePython();

async function describeSkipReason(): Promise<string | undefined> {
  if (platform !== 'darwin' && platform !== 'linux') {
    return `the OS fence requires macOS (Seatbelt) or Linux (bubblewrap); this host is '${platform}'`;
  }
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length > 0) {
    return `sandbox-runtime dependencies are missing on this ${platform} host: ${deps.errors.join(', ')}`;
  }
  if (!pythonPath) {
    return 'no python3/python interpreter is on PATH';
  }
  return;
}

// Resolved before the suite body so the skip message can name the reason.
const skipReason = await describeSkipReason();
if (skipReason) {
  // Loud, not silent: the lane prints why the real-fence proof did not run.
  console.warn(`[fence-executor.integration] SKIPPED — ${skipReason}`);
}

const NO_NETWORK: ExecPolicy = { allowedDomains: [], allowWrite: [] };

describe.skipIf(skipReason !== undefined)('FenceExecutor against the real OS fence', () => {
  let executor: CodeExecutor;
  let scratchDir: string;
  let outsideDir: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'bst-fence-scratch-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'bst-fence-outside-'));
    executor = createFenceExecutor({
      interpreters: { python: { command: pythonPath as string, scriptExtension: 'py' } },
    });
  });

  afterAll(async () => {
    await executor.dispose();
    rmSync(scratchDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  });

  const run = (code: string, overrides: Partial<ExecPolicy> = {}, timeoutMs = 20_000) =>
    executor.execute({
      code,
      language: 'python',
      policy: { ...NO_NETWORK, ...overrides },
      scratchDir,
      timeoutMs,
    });

  it('runs code inside the fence and captures stdout', async () => {
    const result = await run('print("hello from the fence")');
    expect(result.stdout).toContain('hello from the fence');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('propagates a non-zero exit code', async () => {
    const result = await run('import sys; sys.exit(3)');
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('permits writes inside scratchDir', async () => {
    const result = await run('open("inside.txt", "w").write("ok"); print("wrote")');
    expect(result.stderr + result.stdout).toContain('wrote');
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(scratchDir, 'inside.txt'))).toBe(true);
  });

  it('DENIES a write outside scratchDir', async () => {
    const target = join(outsideDir, 'escape.txt');
    const result = await run(`open(${JSON.stringify(target)}, "w").write("pwned")`);
    expect(existsSync(target)).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/PermissionError|Operation not permitted|Read-only|denied/i);
  });

  it('DENIES network access when allowedDomains is empty', async () => {
    const result = await run(
      [
        'import urllib.request',
        'try:',
        '    urllib.request.urlopen("https://example.com", timeout=15)',
        '    print("NETWORK-REACHED")',
        'except Exception as e:',
        '    print("NETWORK-BLOCKED", type(e).__name__)',
      ].join('\n')
    );
    expect(result.stdout).not.toContain('NETWORK-REACHED');
    expect(result.stdout).toContain('NETWORK-BLOCKED');
  });

  it('DENIES reads of the always-denied credential stores even when the policy denies nothing', async () => {
    const sshDir = join(homedir(), '.ssh');
    const hostEntries = existsSync(sshDir) ? readdirSync(sshDir) : [];
    const result = await run(
      ['import glob, os', 'print("SSH", glob.glob(os.path.expanduser("~/.ssh/*")))'].join('\n')
    );
    expect(result.stdout).toContain('SSH []');
    if (hostEntries.length === 0) {
      // Without host content the assertion above proves nothing; say so.
      console.warn(
        '[fence-executor.integration] ~/.ssh is empty on this host, so the deny-read assertion is vacuous.'
      );
    }
  });

  it('DENIES a CHILD process spawned by the sandboxed code from writing outside scratchDir', async () => {
    const target = join(outsideDir, 'child-escape.txt');
    const result = await run(
      [
        'import subprocess, sys',
        `r = subprocess.run([sys.executable, "-c", ${JSON.stringify(
          `open(${JSON.stringify(target)}, "w").write("pwned")`
        )}], capture_output=True, text=True)`,
        'print("CHILD-RC", r.returncode)',
        // The exception line is at the END of the traceback; newer CPython
        // prints wide source-context frames, so take the tail.
        'print("CHILD-ERR", r.stderr.strip().replace("\\n", " | ")[-300:])',
      ].join('\n')
    );
    expect(existsSync(target)).toBe(false);
    expect(result.stdout).not.toContain('CHILD-RC 0');
    expect(result.stdout).toMatch(/PermissionError|Operation not permitted|denied/i);
  });

  it('kills the WHOLE process tree on timeout and reports timedOut', async () => {
    const marker = join(scratchDir, 'orphan-marker.txt');
    rmSync(marker, { force: true });
    const started = Date.now();
    const result = await run(
      [
        'import subprocess, sys, time',
        `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(
          `import time; time.sleep(6); open(${JSON.stringify(marker)}, "w").write("orphan survived")`
        )}])`,
        'time.sleep(60)',
      ].join('\n'),
      {},
      1500
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // The parent was not simply waited out.
    expect(Date.now() - started).toBeLessThan(20_000);

    // The grandchild would write the marker at +6s if it outlived the kill.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('caps captured output and flags truncation', async () => {
    const result = await run(
      [
        'import sys',
        `chunk = "x" * 65536`,
        `for _ in range(${Math.ceil((FENCE_MAX_STREAM_BYTES * 2) / 65_536)}):`,
        '    sys.stdout.write(chunk)',
        'sys.stdout.flush()',
      ].join('\n')
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(FENCE_MAX_STREAM_BYTES);
  });

  it('honours a per-execution network allow-list', async () => {
    const result = await run(
      [
        'import urllib.request',
        'try:',
        '    r = urllib.request.urlopen("https://example.com", timeout=20)',
        '    print("STATUS", r.status)',
        'except Exception as e:',
        '    print("FAILED", type(e).__name__, e)',
      ].join('\n'),
      { allowedDomains: ['example.com'] }
    );
    expect(result.stdout).toContain('STATUS 200');
  });

  it('re-denies the network on the next execution — policy never leaks between runs', async () => {
    const result = await run(
      [
        'import urllib.request',
        'try:',
        '    urllib.request.urlopen("https://example.com", timeout=15)',
        '    print("NETWORK-REACHED")',
        'except Exception as e:',
        '    print("NETWORK-BLOCKED", type(e).__name__)',
      ].join('\n')
    );
    expect(result.stdout).not.toContain('NETWORK-REACHED');
  });
});
