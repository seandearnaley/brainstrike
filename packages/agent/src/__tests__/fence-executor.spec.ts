import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { platform } from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({
  checkDependenciesAsync: vi.fn(async () => ({ errors: [] as string[], warnings: [] as string[] })),
  cleanupAfterCommand: vi.fn(),
  initialize: vi.fn(async () => {}),
  isSupportedPlatform: vi.fn(() => true),
  reset: vi.fn(async () => {}),
  updateConfig: vi.fn(),
  wrapWithSandboxArgv: vi.fn(async (command: string) => ({
    argv: ['/bin/sh', '-c', command],
    env: {},
  })),
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandbox }));
const spawnProbe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnProbe }));

beforeEach(() => {
  sandbox.checkDependenciesAsync.mockResolvedValue({ errors: [], warnings: [] });
  sandbox.initialize.mockResolvedValue(undefined);
  sandbox.reset.mockResolvedValue(undefined);
  sandbox.wrapWithSandboxArgv.mockImplementation(async (command: string) => ({
    argv: ['/bin/sh', '-c', command],
    env: {},
  }));
  spawnProbe.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('brainstrike-fence-ready'));
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  });
});

import { ExecCapabilityMismatchError, type ExecInput } from '../code-execution';
import {
  createFenceExecutor,
  createFenceExecutorFactory,
  FenceExecutorDisposedError,
  FenceInvalidRequestError,
  FenceQueueTimeoutError,
  FenceUnsupportedLanguageError,
  FenceUnsupportedPlatformError,
  isFenceSupported,
} from '../fence/fence-executor';

const interpreters = {
  python: { command: '/usr/bin/python3', scriptExtension: 'py' },
} as const;

const supported = isFenceSupported();

const request = (overrides: Partial<ExecInput> = {}): ExecInput => ({
  code: 'print(1)',
  language: 'python',
  maxOutputBytes: 65_536,
  policy: { allowedDomains: [], allowWrite: ['/tmp'] },
  scratchDir: '/tmp',
  signal: new AbortController().signal,
  timeoutMs: 1000,
  ...overrides,
});

describe('isFenceSupported', () => {
  it('agrees with the platforms this backend claims to fence', () => {
    // darwin (Seatbelt) and linux (bubblewrap) only — win32 is deliberately
    // NOT offered; see docs/agents/code-execution.md.
    expect(isFenceSupported()).toBe(platform === 'darwin' || platform === 'linux');
  });

  // The assertion above restates the implementation against the HOST's
  // platform, so on the CI runners both sides are true and deleting the
  // platform literal would stay green — and the `native-windows` job never
  // runs this package, so the regression would ship. This pins win32 → false
  // independently of where the suite runs (BST-1074).
  it('refuses win32 even though srt reports the platform as supported', async () => {
    vi.resetModules();
    vi.doMock('node:process', async () => {
      const actual = await vi.importActual<typeof import('node:process')>('node:process');
      return { ...actual, default: actual, platform: 'win32' };
    });
    vi.doMock('@anthropic-ai/sandbox-runtime', () => ({
      // srt's own probe DOES return true on Windows — that is the whole point.
      SandboxManager: { isSupportedPlatform: () => true },
    }));
    const mod = await import('../fence/fence-executor');
    expect(mod.isFenceSupported()).toBe(false);
    expect(mod.createFenceExecutorFactory({ interpreters: {} })).toBeUndefined();
    await expect(mod.createFenceExecutor({ interpreters })).rejects.toMatchObject({
      reason: 'sandbox_unsupported_runtime',
    });
    vi.doUnmock('node:process');
    vi.doUnmock('@anthropic-ai/sandbox-runtime');
    vi.resetModules();
  });
});

describe('createFenceExecutorFactory', () => {
  it('returns a factory on a supported platform and undefined otherwise', () => {
    const factory = createFenceExecutorFactory({ interpreters });
    expect(typeof factory === 'function').toBe(supported);
  });

  it('lets the host omit the fence capability entirely rather than degrade it', () => {
    const factory = createFenceExecutorFactory({ interpreters });
    const host = factory ? { fence: factory } : {};
    expect('fence' in host).toBe(supported);
  });
});

describe('createFenceExecutor', () => {
  it.runIf(!supported)('throws a typed error on an unsupported platform', async () => {
    await expect(createFenceExecutor({ interpreters })).rejects.toThrowError(
      FenceUnsupportedPlatformError
    );
  });

  it.runIf(supported)('reports os-fence capabilities honestly', async () => {
    const executor = await createFenceExecutor({ interpreters });
    try {
      expect(executor.capabilities()).toEqual({
        languages: ['python'],
        maxIsolationTier: 'os-fence',
        platform,
        supportsNetwork: true,
      });
    } finally {
      await executor.dispose();
    }
  });

  it.runIf(supported)('advertises only the languages it was given interpreters for', async () => {
    const executor = await createFenceExecutor({
      interpreters: {
        bash: { command: '/bin/bash', scriptExtension: 'sh' },
        python: { command: '/usr/bin/python3', scriptExtension: 'py' },
      },
    });
    try {
      expect([...executor.capabilities().languages].sort()).toEqual(['bash', 'python']);
    } finally {
      await executor.dispose();
    }
  });

  it.runIf(supported)('rejects a language with no injected interpreter', async () => {
    const executor = await createFenceExecutor({ interpreters });
    try {
      // The seam's capability reconciliation refuses it first, so `fence` and
      // `vm` cannot answer this differently; the fence's own guard stays as a
      // backstop behind it.
      await expect(
        executor.execute(request({ code: 'console.log(1)', language: 'javascript' }))
      ).rejects.toBeInstanceOf(ExecCapabilityMismatchError);
    } finally {
      await executor.dispose();
    }
  });

  it.runIf(supported)('rejects execute after dispose instead of silently re-arming', async () => {
    const executor = await createFenceExecutor({ interpreters });
    await executor.dispose();
    await expect(executor.execute(request())).rejects.toThrowError(/disposed/i);
  });

  it.runIf(supported)('dispose is idempotent', async () => {
    const executor = await createFenceExecutor({ interpreters });
    await expect(executor.dispose()).resolves.toBeUndefined();
    await expect(executor.dispose()).resolves.toBeUndefined();
  });

  it.runIf(supported)('rejects a non-positive timeout rather than running unbounded', async () => {
    const executor = await createFenceExecutor({ interpreters });
    try {
      // Now owned by the seam's execInputSchema, which the fence re-parses so
      // a caller that bypassed it still cannot reach a spawn.
      await expect(executor.execute(request({ timeoutMs: 0 }))).rejects.toThrow();
    } finally {
      await executor.dispose();
    }
  });

  it.runIf(supported)('refuses an executor that was given no interpreters at all', async () => {
    await expect(createFenceExecutor({ interpreters: {} })).rejects.toThrowError(
      FenceInvalidRequestError
    );
  });
});

describe('typed fence errors', () => {
  // The tool layer maps these to model-visible structured failures, so the
  // discriminant and the operator-facing text are contract, not decoration.
  it.each([
    [new FenceUnsupportedPlatformError('sunos'), 'fence_unsupported_platform', /sunos/],
    [new FenceUnsupportedLanguageError('python', ['bash']), 'fence_unsupported_language', /bash/],
    [new FenceExecutorDisposedError(), 'fence_executor_disposed', /disposed/i],
    [new FenceInvalidRequestError('nope'), 'fence_invalid_request', /nope/],
    [new FenceQueueTimeoutError(1234), 'fence_queue_timeout', /1234ms/],
  ])('%s carries a stable code and an actionable message', (error, code, messagePattern) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
    expect(error.message).toMatch(messagePattern);
  });

  it('names the requested language and what the fence can actually run', () => {
    const error = new FenceUnsupportedLanguageError('javascript', ['python']);
    expect(error.language).toBe('javascript');
    expect(error.message).toContain('javascript');
    expect(error.message).toContain('python');
  });

  it('says plainly that nothing ran when the budget was spent queueing', () => {
    expect(new FenceQueueTimeoutError(500).message).toMatch(/no code was run/i);
    expect(new FenceQueueTimeoutError(500).timeoutMs).toBe(500);
  });
});

describe.skipIf(!supported)('construction-time fence readiness', () => {
  it('waits for a real wrapped probe before returning an executor', async () => {
    const executor = await createFenceExecutor({ interpreters });
    try {
      expect(sandbox.initialize).toHaveBeenCalled();
      expect(sandbox.wrapWithSandboxArgv).toHaveBeenCalledWith(
        "printf '%s' 'brainstrike-fence-ready'",
        undefined,
        expect.objectContaining({ network: { allowedDomains: [], deniedDomains: [] } }),
        expect.any(AbortSignal),
        expect.any(String)
      );
      expect(spawnProbe).toHaveBeenCalledTimes(1);
      expect(existsSync(spawnProbe.mock.calls[0]?.[2].cwd)).toBe(false);
      expect(spawnProbe.mock.calls[0]?.[1]).not.toContain('/usr/bin/python3');
    } finally {
      await executor.dispose();
    }
  });

  it('rejects missing dependencies before spawning or advertising a capability', async () => {
    sandbox.checkDependenciesAsync.mockResolvedValue({
      errors: ['socat not installed'],
      warnings: [],
    });
    await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
      code: 'fence_readiness_unavailable',
      message: expect.stringContaining('socat'),
      reason: 'sandbox_dependencies_missing',
    });
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('refuses the runtime when seccomp would silently degrade', async () => {
    sandbox.checkDependenciesAsync.mockResolvedValue({
      errors: [],
      warnings: ['seccomp not available - unix socket access not restricted'],
    });
    await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
      reason: 'sandbox_unsupported_runtime',
    });
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it.each([
    'bwrap: Creating new namespace failed: Operation not permitted',
    'bwrap: setting up uid map: Permission denied',
    'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    'bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted',
  ])('rejects a namespace denied by the host: %s', async (diagnostic) => {
    spawnProbe.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdout: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from(diagnostic));
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
      return child;
    });
    await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
      reason: 'sandbox_namespace_blocked',
    });
    expect(sandbox.reset).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!supported)('readiness failure lifetime', () => {
  it.each(['initialize', 'wrapWithSandboxArgv'] as const)(
    'bounds a stalled %s and holds the session lock until late cleanup',
    async (stage) => {
      let release: (() => void) | undefined;
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === 'initialize') {
        sandbox.initialize.mockImplementationOnce(() => stalled);
      } else {
        sandbox.wrapWithSandboxArgv.mockImplementationOnce(async (command: string) => {
          await stalled;
          return { argv: ['/bin/sh', '-c', command], env: {} };
        });
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const pending = createFenceExecutor({ interpreters });
        const failure = expect(pending).rejects.toMatchObject({
          reason: 'sandbox_readiness_timeout',
        });
        await vi.waitFor(() => expect(sandbox[stage]).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(5000);
        await failure;
        expect(spawnProbe).not.toHaveBeenCalled();
        // A later attempt cannot update global config while the timed-out
        // initializer/wrapper is still pending, even after its caller returns.
        const retried = createFenceExecutor({ interpreters });
        await Promise.resolve();
        expect(sandbox.reset).not.toHaveBeenCalled();
        expect(sandbox[stage]).toHaveBeenCalledTimes(1);
        release?.();
        const executor = await retried;
        await executor.dispose();
        expect(spawnProbe).toHaveBeenCalledTimes(1);
        expect(sandbox.reset).toHaveBeenCalledTimes(2);
      } finally {
        release?.();
        vi.useRealTimers();
      }
    }
  );

  it('honours caller cancellation before starting the dependency check', async () => {
    const controller = new AbortController();
    const reason = new Error('Stopped');
    controller.abort(reason);
    await expect(createFenceExecutor({ interpreters }, controller.signal)).rejects.toBe(reason);
    expect(sandbox.checkDependenciesAsync).not.toHaveBeenCalled();
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('cleans a failed probe without resetting another executor, and retries successfully', async () => {
    const first = await createFenceExecutor({ interpreters });
    sandbox.wrapWithSandboxArgv.mockRejectedValueOnce(new Error('wrapper failed'));
    await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
      reason: 'sandbox_readiness_failed',
    });
    expect(sandbox.reset).not.toHaveBeenCalled();
    const second = await createFenceExecutor({ interpreters });
    expect(sandbox.initialize).toHaveBeenCalledTimes(1);
    await first.dispose();
    expect(sandbox.reset).not.toHaveBeenCalled();
    await second.dispose();
    expect(sandbox.reset).toHaveBeenCalledTimes(1);
  });

  it('requires the success marker as well as exit zero', async () => {
    spawnProbe.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdout: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    });
    await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
      reason: 'sandbox_readiness_failed',
    });
    expect(sandbox.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.reset).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!supported)('readiness probe process cancellation', () => {
  it('bounds a stuck probe and joins its normal process-group cleanup before retry', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
    });
    spawnProbe.mockImplementationOnce(() =>
      Object.assign(new EventEmitter(), {
        pid: 424_242,
        stderr: new EventEmitter(),
        stdout: new EventEmitter(),
      })
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const pending = createFenceExecutor({ interpreters });
      const failure = expect(pending).rejects.toMatchObject({
        reason: 'sandbox_readiness_timeout',
      });
      await vi.waitFor(() => expect(spawnProbe).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5000);
      await failure;
      const executor = await createFenceExecutor({ interpreters });
      await executor.dispose();
      expect(spawnProbe).toHaveBeenCalledTimes(2);
      expect(sandbox.cleanupAfterCommand).toHaveBeenCalledTimes(2);
      expect(sandbox.reset).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!supported)('readiness diagnostic bounds', () => {
  it('bounds unexpected probe stderr without exposing it as actionable user guidance', async () => {
    spawnProbe.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdout: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('x'.repeat(10_000)));
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
      return child;
    });
    await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
      cause: { message: 'x'.repeat(4096) },
      message: expect.not.stringContaining('xxxx'),
      reason: 'sandbox_readiness_failed',
    });
  });
});
