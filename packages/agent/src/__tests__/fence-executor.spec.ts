import { platform } from 'node:process';
import { describe, expect, it, vi } from 'vitest';

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
  it.runIf(!supported)('throws a typed error on an unsupported platform', () => {
    expect(() => createFenceExecutor({ interpreters })).toThrowError(FenceUnsupportedPlatformError);
  });

  it.runIf(supported)('reports os-fence capabilities honestly', async () => {
    const executor = createFenceExecutor({ interpreters });
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
    const executor = createFenceExecutor({
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
    const executor = createFenceExecutor({ interpreters });
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
    const executor = createFenceExecutor({ interpreters });
    await executor.dispose();
    await expect(executor.execute(request())).rejects.toThrowError(/disposed/i);
  });

  it.runIf(supported)('dispose is idempotent', async () => {
    const executor = createFenceExecutor({ interpreters });
    await expect(executor.dispose()).resolves.toBeUndefined();
    await expect(executor.dispose()).resolves.toBeUndefined();
  });

  it.runIf(supported)('rejects a non-positive timeout rather than running unbounded', async () => {
    const executor = createFenceExecutor({ interpreters });
    try {
      // Now owned by the seam's execInputSchema, which the fence re-parses so
      // a caller that bypassed it still cannot reach a spawn.
      await expect(executor.execute(request({ timeoutMs: 0 }))).rejects.toThrow();
    } finally {
      await executor.dispose();
    }
  });

  it.runIf(supported)('refuses an executor that was given no interpreters at all', () => {
    expect(() => createFenceExecutor({ interpreters: {} })).toThrowError(FenceInvalidRequestError);
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
