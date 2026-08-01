import { platform } from 'node:process';
import { describe, expect, it } from 'vitest';

import {
  createFenceExecutor,
  createFenceExecutorFactory,
  FENCE_MAX_STREAM_BYTES,
  FenceUnsupportedLanguageError,
  FenceUnsupportedPlatformError,
  isFenceSupported,
} from '../fence/fence-executor';

const interpreters = {
  python: { command: '/usr/bin/python3', scriptExtension: 'py' },
} as const;

const supported = isFenceSupported();

describe('isFenceSupported', () => {
  it('agrees with the platforms this backend claims to fence', () => {
    // darwin (Seatbelt) and linux (bubblewrap) only — win32 is deliberately
    // NOT offered; see docs/agents/code-execution.md.
    expect(isFenceSupported()).toBe(platform === 'darwin' || platform === 'linux');
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
      await expect(
        executor.execute({
          code: 'console.log(1)',
          language: 'javascript',
          policy: { allowedDomains: [], allowWrite: [] },
          scratchDir: '/tmp',
          timeoutMs: 1000,
        })
      ).rejects.toBeInstanceOf(FenceUnsupportedLanguageError);
    } finally {
      await executor.dispose();
    }
  });

  it.runIf(supported)('rejects execute after dispose instead of silently re-arming', async () => {
    const executor = createFenceExecutor({ interpreters });
    await executor.dispose();
    await expect(
      executor.execute({
        code: 'print(1)',
        language: 'python',
        policy: { allowedDomains: [], allowWrite: [] },
        scratchDir: '/tmp',
        timeoutMs: 1000,
      })
    ).rejects.toThrowError(/disposed/i);
  });

  it.runIf(supported)('dispose is idempotent', async () => {
    const executor = createFenceExecutor({ interpreters });
    await expect(executor.dispose()).resolves.toBeUndefined();
    await expect(executor.dispose()).resolves.toBeUndefined();
  });

  it.runIf(supported)('rejects a non-positive timeout rather than running unbounded', async () => {
    const executor = createFenceExecutor({ interpreters });
    try {
      await expect(
        executor.execute({
          code: 'print(1)',
          language: 'python',
          policy: { allowedDomains: [], allowWrite: [] },
          scratchDir: '/tmp',
          timeoutMs: 0,
        })
      ).rejects.toThrowError(/timeoutMs/);
    } finally {
      await executor.dispose();
    }
  });
});

describe('FENCE_MAX_STREAM_BYTES', () => {
  it('caps each captured stream at 1 MiB', () => {
    expect(FENCE_MAX_STREAM_BYTES).toBe(1024 * 1024);
  });
});
