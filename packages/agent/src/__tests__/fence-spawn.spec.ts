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

import {
  buildSandboxEnv,
  type ChildProcessLike,
  FENCE_MAX_STREAM_BYTES,
  type FenceSpawnDeps,
  INHERITED_ENV_VARS,
  spawnFenced,
} from '../fence/fence-executor';

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

const run = (deps: FenceSpawnDeps, timeoutMs = 10_000) =>
  spawnFenced(['/bin/sh', '-c', 'true'], {}, '/tmp', timeoutMs, deps);

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
      // 128 + SIGKILL(9).
      expect(result.exitCode).toBe(137);
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

  it('maps a signal death with no exit code to 128 + signum', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitExit(null, 'SIGTERM');
    child.emitClose(null, 'SIGTERM');
    const result = await pending;
    expect(result.exitCode).toBe(143);
  });

  it('rejects on spawn error without settling an ExecResult', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitError(new Error('ENOENT'));
    await expect(pending).rejects.toThrowError(/ENOENT/);
  });

  it('rejects an empty command vector rather than spawning something implicit', async () => {
    const { deps } = harness();
    await expect(spawnFenced([], {}, '/tmp', 1000, deps)).rejects.toThrowError(/empty command/i);
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
    expect(result.truncated).toBe(false);
  });

  it('clips at exactly the cap and keeps draining instead of blocking the pipe', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitStdout(Buffer.alloc(FENCE_MAX_STREAM_BYTES - 1, 0x61));
    // Straddles the boundary: partially kept, and marks truncation.
    child.emitStdout(Buffer.alloc(10, 0x62));
    // Arrives after the cap: dropped, but accepted without throwing.
    child.emitStdout(Buffer.alloc(1024, 0x63));
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(FENCE_MAX_STREAM_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.stdout.endsWith('b')).toBe(true);
    expect(result.stdout).not.toContain('c');
  });

  it('flags truncation when only stderr overflows', async () => {
    const { child, deps } = harness();
    const pending = run(deps);
    child.emitStderr(Buffer.alloc(FENCE_MAX_STREAM_BYTES + 1, 0x61));
    child.emitExit(0);
    child.emitClose(0);
    const result = await pending;
    expect(result.truncated).toBe(true);
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
