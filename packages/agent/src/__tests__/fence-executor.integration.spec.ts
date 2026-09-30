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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CodeExecutor,
  type ExecPolicy,
  isExecAbortedError,
  isExecResultTruncated,
} from '../code-execution';
import { createFenceExecutor } from '../fence/fence-executor';
import {
  describeFenceHostSkipReason,
  refuseToSkipInAPromisedLane,
} from './fixtures/fence-host-gate';

/** Per-request output cap; small enough to overflow without minutes of I/O. */
const MAX_OUTPUT_BYTES = 256 * 1024;

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

const PROBE_URL = 'https://example.com';

/**
 * Unsandboxed reachability probe. The allow-list test asserts a real 200
 * through srt's proxy, so on a host with restricted egress it would fail RED
 * for a reason that has nothing to do with the fence. Its sibling
 * "re-denies the network" test would then pass VACUOUSLY, since absence of a
 * reachable host is indistinguishable from a working deny — so the whole
 * suite skips together rather than reporting a leak guard it never exercised.
 */
async function isNetworkReachable(): Promise<boolean> {
  try {
    const response = await fetch(PROBE_URL, { signal: AbortSignal.timeout(15_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function describeSkipReason(): Promise<string | undefined> {
  const hostReason = await describeFenceHostSkipReason();
  if (hostReason) {
    return hostReason;
  }
  if (!pythonPath) {
    return 'no python3/python interpreter is on PATH';
  }
  if (!(await isNetworkReachable())) {
    return `${PROBE_URL} is not reachable unsandboxed, so neither the network allow-list nor the (otherwise vacuous) network-deny assertions can be proven here`;
  }
  return;
}

// Resolved before the suite body so the skip message can name the reason.
// Routed through the shared gate LAST, once every prerequisite has had its say:
// a lane that declared BRAINSTRIKE_FENCE_DEPS_REQUIRED promised all of them, so
// there it throws rather than skipping. Note this suite skips ENTIRELY when the
// probe host is unreachable — the filesystem and process-tree proofs go with it
// — which is why the escalation cannot be scoped to the dependency reason alone.
const skipReason = refuseToSkipInAPromisedLane(
  'fence-executor.integration',
  await describeSkipReason()
);
if (skipReason) {
  // Loud, not silent: the lane prints why the real-fence proof did not run.
  console.warn(`[fence-executor.integration] SKIPPED — ${skipReason}`);
}

const NO_NETWORK: Omit<ExecPolicy, 'allowWrite'> = { allowedDomains: [] };

describe.skipIf(skipReason !== undefined)('FenceExecutor against the real OS fence', () => {
  let executor: CodeExecutor;
  let scratchDir: string;
  let outsideDir: string;

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'bst-fence-scratch-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'bst-fence-outside-'));
    executor = await createFenceExecutor({
      interpreters: { python: { command: pythonPath as string, scriptExtension: 'py' } },
    });
  });

  afterAll(async () => {
    await executor?.dispose();
    rmSync(scratchDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  });

  const run = (
    code: string,
    overrides: Partial<ExecPolicy> = {},
    timeoutMs = 20_000,
    signal: AbortSignal = new AbortController().signal
  ) =>
    executor.execute({
      code,
      language: 'python',
      maxOutputBytes: MAX_OUTPUT_BYTES,
      // The seam requires scratchDir ⊆ allowWrite, so an interpreter can
      // always write its own scratch dir.
      policy: { ...NO_NETWORK, allowWrite: [scratchDir], ...overrides },
      scratchDir,
      signal,
      timeoutMs,
    });

  it('runs code inside the fence and captures stdout', async () => {
    const result = await run('print("hello from the fence")');
    expect(result.stdout).toContain('hello from the fence');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(isExecResultTruncated(result)).toBe(false);
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
    // The denial WORDING is platform-specific and both shapes are real
    // denials: Seatbelt refuses the open outright (`PermissionError` /
    // "Operation not permitted"), while bubblewrap masks everything outside
    // the write grant by re-mounting it read-only, so CPython raises
    // `OSError: [Errno 30] Read-only file system`. Its sibling "DENIES a write
    // outside scratchDir" above already names that shape; this case simply
    // missed it, which only surfaced once Linux CI started running these
    // suites for real (measured on Ubuntu 24.04 / bubblewrap 0.9.0).
    // Deliberately still an ENUMERATION of denial shapes rather than "any
    // error": the two assertions above pin that nothing was written, and this
    // one has to keep proving the write was REFUSED rather than failing for
    // some unrelated reason.
    expect(result.stdout).toMatch(
      /PermissionError|Operation not permitted|Read-only file system|denied/i
    );
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
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
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
        `for _ in range(${Math.ceil((MAX_OUTPUT_BYTES * 2) / 65_536)}):`,
        '    sys.stdout.write(chunk)',
        'sys.stdout.flush()',
      ].join('\n')
    );
    expect(isExecResultTruncated(result)).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_OUTPUT_BYTES);
    expect(result.stdoutOmittedBytes).toBeGreaterThan(0);
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
    // Not merely "absent": the suite only runs when the host CAN reach this
    // URL, so a block here is the fence, not a dead network.
    expect(result.stdout).toContain('NETWORK-BLOCKED');
  });

  it('does NOT hand host environment secrets to the sandboxed process', async () => {
    // The filesystem deny-list is pointless if the same secrets ride in on
    // the environment. This is the channel nothing else in the suite covers.
    const canary = 'bst-fence-canary-must-not-leak';
    process.env['AWS_SECRET_ACCESS_KEY'] = canary;
    process.env['ANTHROPIC_API_KEY'] = canary;
    process.env['BRAINSTRIKE_FENCE_CANARY'] = canary;
    try {
      const result = await run(
        [
          'import os',
          'names = ["AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "BRAINSTRIKE_FENCE_CANARY"]',
          'print("LEAKED", [n for n in names if n in os.environ])',
          'print("ALLENV", "|".join(os.environ.values()))',
        ].join('\n')
      );
      expect(result.stdout).toContain('LEAKED []');
      expect(result.stdout).not.toContain(canary);
      // The interpreter still gets what it needs to run at all.
      expect(result.exitCode).toBe(0);
    } finally {
      process.env['AWS_SECRET_ACCESS_KEY'] = undefined;
      process.env['ANTHROPIC_API_KEY'] = undefined;
      process.env['BRAINSTRIKE_FENCE_CANARY'] = undefined;
    }
  });

  it('passes through the interpreter env a caller explicitly declared', async () => {
    const declared = await createFenceExecutor({
      interpreters: {
        python: {
          command: pythonPath as string,
          env: { BRAINSTRIKE_DECLARED: 'declared-value' },
          scriptExtension: 'py',
        },
      },
    });
    try {
      const result = await declared.execute({
        code: 'import os; print("DECLARED", os.environ.get("BRAINSTRIKE_DECLARED"))',
        language: 'python',
        maxOutputBytes: MAX_OUTPUT_BYTES,
        policy: { ...NO_NETWORK, allowWrite: [scratchDir] },
        scratchDir,
        signal: new AbortController().signal,
        timeoutMs: 20_000,
      });
      expect(result.stdout).toContain('DECLARED declared-value');
    } finally {
      await declared.dispose();
    }
  });

  it('aborts a running execution, kills its tree, and keeps the partial output', async () => {
    const marker = join(scratchDir, 'aborted-marker.txt');
    rmSync(marker, { force: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);

    let caught: unknown;
    try {
      await run(
        [
          'import subprocess, sys, time',
          'print("BEFORE-ABORT", flush=True)',
          `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(
            `import time; time.sleep(6); open(${JSON.stringify(marker)}, "w").write("survived")`
          )}])`,
          'time.sleep(60)',
        ].join('\n'),
        {},
        60_000,
        controller.signal
      );
    } catch (error) {
      caught = error;
    }

    // An abort is not a completed run: it throws rather than returning a
    // result that a consumer would have to tell apart from a timeout.
    const caughtDescription =
      caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    expect(
      isExecAbortedError(caught),
      `Expected ExecAbortedError, received ${caughtDescription}`
    ).toBe(true);
    if (!isExecAbortedError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.processStarted).toBe(true);
    expect(caught.partialStdout).toContain('BEFORE-ABORT');

    // The descendant would write the marker at +6s if the tree outlived Stop.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('does not settle until the process group is down, even when stdio closes early', async () => {
    // The descendant detaches its stdio, so our pipes close while it is still
    // alive. Settling there would return with it running, free to outlive the
    // policy this run was granted.
    const marker = join(scratchDir, 'detached-stdio-marker.txt');
    rmSync(marker, { force: true });
    const result = await run(
      [
        'import subprocess, sys, os',
        'devnull = os.open(os.devnull, os.O_RDWR)',
        `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(
          `import time; time.sleep(5); open(${JSON.stringify(marker)}, "w").write("survived")`
        )}], stdin=devnull, stdout=devnull, stderr=devnull)`,
        'print("PARENT-DONE")',
      ].join('\n')
    );
    expect(result.stdout).toContain('PARENT-DONE');
    expect(result.timedOut).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 8000));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
