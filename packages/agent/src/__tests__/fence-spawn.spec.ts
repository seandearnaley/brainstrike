/**
 * Unit tests for the two fence decisions that carry security weight but do not
 * need a real sandbox: the teardown state machine and the environment
 * allow-list.
 *
 * The state machine is driven by a FAKE child process. That is the point — the
 * dangerous interleavings (pipes close before the root exits; a timeout racing
 * an exit) cannot be produced on demand against a real OS process, and it is
 * exactly those orderings that decide whether a process group can outlive the
 * policy it was granted. The real-fence proof lives in
 * fence-executor.integration.spec.ts.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { isExecAbortedError } from '../code-execution';
import {
  buildSandboxEnv,
  type ChildProcessLike,
  type FenceSpawnDeps,
  INHERITED_ENV_VARS,
  spawnFenced,
} from '../fence/fence-executor';

/** Stands in for the seam's per-request cap; small enough to overflow cheaply. */
const CAP = 1024;

interface FakeChild extends ChildProcessLike {
  emitClose(code?: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitStderr(chunk: Buffer): void;
  emitStdout(chunk: Buffer): void;
}

function createFakeChild(pid: number | undefined = 4242): FakeChild {
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return {
    emitClose: (code = null, signal = null) => events.emit('close', code, signal),
    emitError: (error) => events.emit('error', error),
    emitExit: (code, signal = null) => events.emit('exit', code, signal),
    emitStderr: (chunk) => stderr.emit('data', chunk),
    emitStdout: (chunk) => stdout.emit('data', chunk),
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
    pid,
    stderr: stderr as unknown as ChildProcessLike['stderr'],
    stdout: stdout as unknown as ChildProcessLike['stdout'],
  } as FakeChild;
}

function harness(pid?: number): {
  child: FakeChild;
  deps: FenceSpawnDeps;
  killGroup: ReturnType<typeof vi.fn>;
} {
  const child = createFakeChild(pid);
  const killGroup = vi.fn();
  return {
    child,
    deps: { killGroup, spawnProcess: () => child },
    killGroup,
  };
}

const run = (
  deps: FenceSpawnDeps,
  timeoutMs = 10_000,
  signal: AbortSignal = new AbortController().signal,
  maxOutputBytes = CAP
) =>
  spawnFenced({
    argv: ['/bin/sh', '-c', 'true'],
    cwd: '/tmp',
    deps,
    env: {},
    maxOutputBytes,
    signal,
    timeoutMs,
  });

describe('spawnFenced teardown', () => {
  it('does NOT settle when the pipes close before the root has exited', async () => {
    // A descendant that detached its stdio closes our pipes while still alive.
    // Settling here is the P1: it would return with that process running.
    const { child, deps } = harness();
    const settled = vi.fn();
    const pending = run(deps).then(settled);

    child.emitClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    child.emitExit(0);
    child.emitClose(0);
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('SIGKILLs the process group on the settle path, on a clean exit', async () => {
    const { child, deps, killGroup } = harness(99);
    const pending = run(deps);
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;

    expect(killGroup).toHaveBeenCalledWith(99, 'SIGKILL');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('escalates SIGTERM then SIGKILL on timeout and reports timedOut', async () => {
    vi.useFakeTimers();
    try {
      const { child, deps, killGroup } = harness(77);
      const pending = run(deps, 1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(killGroup).toHaveBeenCalledWith(77, 'SIGTERM');

      await vi.advanceTimersByTimeAsync(500);
      expect(killGroup).toHaveBeenCalledWith(77, 'SIGKILL');

      child.emitExit(null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;

      expect(result.timedOut).toBe(true);
      // The seam pins this: a signal death reports exitCode null + the signal
      // name, so the tool layer never has to normalize a per-backend code.
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports the timeout when the process never exits at all', async () => {
    vi.useFakeTimers();
    try {
      const { deps, killGroup } = harness(55);
      const pending = run(deps, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      const result = await pending;

      expect(result.timedOut).toBe(true);
      expect(killGroup).toHaveBeenCalledWith(55, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a late close undo a timeout that already fired', async () => {
    vi.useFakeTimers();
    try {
      const { child, deps } = harness();
      const pending = run(deps, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      child.emitExit(null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a signal death as exitCode null plus the signal name', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitExit(null, 'SIGTERM');
    child.emitClose(null, 'SIGTERM');
    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(result.timedOut).toBe(false);
  });

  it('reports a clean exit as exitCode 0 with no signal', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it('rejects on spawn error without settling an ExecResult', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitError(new Error('ENOENT'));
    await expect(pending).rejects.toThrowError(/ENOENT/);
  });

  it('rejects an empty command vector rather than spawning something implicit', async () => {
    const { deps } = harness();
    await expect(
      spawnFenced({
        argv: [],
        cwd: '/tmp',
        deps,
        env: {},
        maxOutputBytes: CAP,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      })
    ).rejects.toThrowError(/empty command/i);
  });
});

describe('spawnFenced capture', () => {
  it('captures both streams up to the cap and flags truncation per run', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitStdout(Buffer.from('out'));
    child.emitStderr(Buffer.from('err'));
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.stdoutOmittedBytes).toBe(0);
    expect(result.stderrOmittedBytes).toBe(0);
  });

  it('clips at exactly the cap and keeps draining instead of blocking the pipe', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitStdout(Buffer.alloc(CAP - 1, 0x61));
    // Straddles the boundary: 1 byte kept, 9 counted as omitted.
    child.emitStdout(Buffer.alloc(10, 0x62));
    // Arrives after the cap: all 1024 counted, accepted without throwing.
    child.emitStdout(Buffer.alloc(1024, 0x63));
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(CAP);
    // A boolean could not say this. 9 dropped from the straddling chunk plus
    // the whole 1024 that arrived after the cap.
    expect(result.stdoutOmittedBytes).toBe(9 + 1024);
    expect(result.stdout.endsWith('b')).toBe(true);
    expect(result.stdout).not.toContain('c');
  });

  it('counts omitted bytes per stream, never conflating the two', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitStderr(Buffer.alloc(CAP + 7, 0x61));
    child.emitStdout(Buffer.from('short'));
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;
    expect(result.stderrOmittedBytes).toBe(7);
    expect(result.stdoutOmittedBytes).toBe(0);
  });

  it('honours the per-request cap rather than a backend constant', async () => {
    const { child, deps } = harness();
    const pending = run(deps, 10_000, new AbortController().signal, 16);
    child.emitStdout(Buffer.alloc(20, 0x61));
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(16);
    expect(result.stdoutOmittedBytes).toBe(4);
  });
});

describe('spawnFenced cancellation', () => {
  it('throws ExecAbortedError mid-run and kills the group, carrying partial output', async () => {
    const controller = new AbortController();
    const { child, deps, killGroup } = harness(31);
    const pending = run(deps, 10_000, controller.signal);
    child.emitStdout(Buffer.from('partial-out'));
    child.emitStderr(Buffer.from('partial-err'));

    controller.abort();
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }

    expect(isExecAbortedError(caught)).toBe(true);
    if (!isExecAbortedError(caught)) {
      throw new Error('unreachable');
    }
    // An abort is not a completed run, so it never resolves an ExecResult —
    // but the output it did produce is not thrown away either.
    expect(caught.processStarted).toBe(true);
    expect(caught.partialStdout).toBe('partial-out');
    expect(caught.partialStderr).toBe('partial-err');
    expect(caught.code).toBe('exec_aborted');
    expect(killGroup).toHaveBeenCalledWith(31, 'SIGKILL');
  });

  it('throws immediately when the signal is already aborted', async () => {
    const { deps } = harness();
    await expect(run(deps, 10_000, AbortSignal.abort())).rejects.toSatisfy((error: unknown) =>
      isExecAbortedError(error)
    );
  });

  it('does not abort a run that already settled', async () => {
    const controller = new AbortController();
    const { child, deps } = harness();
    const pending = run(deps, 10_000, controller.signal);
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;
    controller.abort();
    expect(result.exitCode).toBe(0);
  });
});

describe('buildSandboxEnv', () => {
  it('passes through only the allow-listed host variables', () => {
    const env = buildSandboxEnv({}, undefined);
    for (const name of Object.keys(env)) {
      expect(INHERITED_ENV_VARS).toContain(name);
    }
  });

  it('drops host secrets that are not on the allow-list', () => {
    process.env['BST_UNIT_FAKE_SECRET'] = 'super-secret';
    try {
      const env = buildSandboxEnv({ ...process.env }, undefined);
      expect(env['BST_UNIT_FAKE_SECRET']).toBeUndefined();
      expect(Object.values(env)).not.toContain('super-secret');
    } finally {
      process.env['BST_UNIT_FAKE_SECRET'] = undefined;
    }
  });

  it('carries over variables srt CHANGED, so a future srt keeps working', () => {
    const env = buildSandboxEnv({ HTTPS_PROXY: 'http://127.0.0.1:9', ...{} }, undefined);
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:9');
  });

  it('includes the interpreter env a caller declared explicitly', () => {
    const env = buildSandboxEnv({}, { PYTHONHOME: '/opt/py' });
    expect(env['PYTHONHOME']).toBe('/opt/py');
  });

  it('lets an srt-set value win over a declared interpreter value', () => {
    // srt's proxy wiring is what makes the network policy work; a caller must
    // not be able to shadow it out of the environment.
    const env = buildSandboxEnv({ HTTPS_PROXY: 'http://127.0.0.1:9' }, { HTTPS_PROXY: 'direct' });
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:9');
  });
});
