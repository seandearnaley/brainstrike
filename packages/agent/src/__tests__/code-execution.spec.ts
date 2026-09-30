import { describe, expect, it, vi } from 'vitest';

import {
  assertExecRequestSatisfiable,
  type CodeExecutor,
  createNullCodeExecutor,
  ExecAbortedError,
  ExecCapabilityMismatchError,
  type ExecInput,
  type ExecutorCapabilities,
  ExecutorKindUnavailableError,
  ExecutorTierMismatchError,
  execInputSchema,
  execPolicySchema,
  isExecAbortedError,
  isExecCapabilityMismatchError,
  isExecResultTruncated,
  isExecutorKindUnavailableError,
  isExecutorTierMismatchError,
  isPathCoveredBy,
  MAX_EXEC_TIMEOUT_MS,
  NoSandboxConfiguredError,
  parseExecutorKind,
  resolveCodeExecutor,
} from '../code-execution';

const fenceCapabilities: ExecutorCapabilities = {
  languages: ['python'],
  maxIsolationTier: 'os-fence',
  platform: 'darwin',
  supportsNetwork: true,
};

const stubExecutor = (capabilities: ExecutorCapabilities = fenceCapabilities): CodeExecutor => ({
  capabilities: () => capabilities,
  dispose: () => Promise.resolve(),
  execute: () =>
    Promise.resolve({
      exitCode: 0,
      signal: null,
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: '',
      stdoutOmittedBytes: 0,
      timedOut: false,
    }),
});

const validInput = (overrides: Partial<ExecInput> = {}): ExecInput => ({
  code: 'print(1)',
  language: 'python',
  maxOutputBytes: 65_536,
  policy: { allowedDomains: [], allowWrite: ['/tmp/scratch'] },
  scratchDir: '/tmp/scratch',
  signal: new AbortController().signal,
  timeoutMs: 5000,
  ...overrides,
});

describe('parseExecutorKind', () => {
  it('accepts the two supported kinds', () => {
    expect(parseExecutorKind('fence')).toBe('fence');
    expect(parseExecutorKind('vm')).toBe('vm');
  });

  it.each(['docker', '', 'FENCE', 0, null, undefined, {}, Symbol('fence')])(
    'throws the contracted error on unsupported value %j',
    (value) => {
      expect(() => parseExecutorKind(value)).toThrowError(/not a supported code-execution mode/);
    }
  );

  it('throws the contracted error for a BigInt rather than a serialization TypeError', () => {
    expect(() => parseExecutorKind(1n)).toThrowError(/not a supported code-execution mode/);
  });

  it('throws the contracted error for a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseExecutorKind(circular)).toThrowError(/not a supported code-execution mode/);
  });
});

describe('execPolicySchema', () => {
  it('parses a full policy', () => {
    const policy = execPolicySchema.parse({
      allowedDomains: ['api.github.com', '*.github.com'],
      allowRead: ['/opt/data'],
      allowWrite: ['/tmp/scratch'],
      denyRead: ['/Users/someone/.ssh'],
    });
    expect(policy.allowWrite).toEqual(['/tmp/scratch']);
    expect(policy.allowedDomains).toEqual(['api.github.com', '*.github.com']);
  });

  it('accepts an empty allowedDomains list (no network)', () => {
    const policy = execPolicySchema.parse({
      allowedDomains: [],
      allowWrite: ['/tmp/scratch'],
    });
    expect(policy.allowedDomains).toEqual([]);
    expect(policy.allowRead).toBeUndefined();
  });

  it.each([
    ['missing allowWrite', { allowedDomains: [] }],
    ['missing allowedDomains', { allowWrite: ['/tmp/scratch'] }],
    ['unknown key', { allowedDomains: [], allowNetwork: true, allowWrite: ['/tmp/scratch'] }],
    ['non-string path', { allowedDomains: [], allowWrite: [42] }],
    ['blank path', { allowedDomains: [], allowWrite: ['  '] }],
    ['blank domain', { allowedDomains: [''], allowWrite: ['/tmp/scratch'] }],
  ])('rejects %s', (_label, value) => {
    expect(() => execPolicySchema.parse(value)).toThrowError();
  });

  it.each([
    ['a home-relative path', '~/.ssh'],
    ['a bare tilde', '~'],
    ['a relative path', 'relative/path'],
    ['a traversal path', '/tmp/scratch/../../etc'],
    ['a bare traversal', '..'],
    ['an over-long path', `/${'a'.repeat(5000)}`],
  ])('rejects %s in allowWrite', (_label, entry) => {
    expect(() =>
      execPolicySchema.parse({ allowedDomains: [], allowWrite: [entry] })
    ).toThrowError();
  });

  it('rejects a bare "*" wildcard, which would invert the no-network invariant', () => {
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: ['*'],
        allowWrite: ['/tmp/scratch'],
      })
    ).toThrowError();
  });

  it.each(['not a domain!', 'http://example.com', '*.*', 'exa mple.com', '*.com', '*.io'])(
    'rejects malformed or over-broad domain %j',
    (domain) => {
      expect(() =>
        execPolicySchema.parse({
          allowedDomains: [domain],
          allowWrite: ['/tmp/scratch'],
        })
      ).toThrowError();
    }
  );

  it('rejects an over-long entry list', () => {
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: [],
        allowWrite: Array.from({ length: 300 }, (_, i) => `/tmp/scratch/${i}`),
      })
    ).toThrowError();
  });
});

describe('execInputSchema', () => {
  it('parses a valid request', () => {
    expect(() => execInputSchema.parse(validInput())).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_EXEC_TIMEOUT_MS + 1])(
    'rejects timeoutMs %j',
    (timeoutMs) => {
      expect(() =>
        execInputSchema.parse(validInput({ timeoutMs } as Partial<ExecInput>))
      ).toThrowError();
    }
  );

  it.each([0, -1, Number.NaN])('rejects maxOutputBytes %j', (maxOutputBytes) => {
    expect(() =>
      execInputSchema.parse(validInput({ maxOutputBytes } as Partial<ExecInput>))
    ).toThrowError();
  });

  it('rejects a blank scratchDir', () => {
    expect(() => execInputSchema.parse(validInput({ scratchDir: '' }))).toThrowError();
  });

  it('rejects a relative scratchDir', () => {
    expect(() => execInputSchema.parse(validInput({ scratchDir: 'scratch' }))).toThrowError();
  });

  it('rejects a scratchDir the policy cannot write', () => {
    expect(() =>
      execInputSchema.parse(
        validInput({
          policy: { allowedDomains: [], allowWrite: ['/tmp/other'] },
          scratchDir: '/tmp/scratch',
        })
      )
    ).toThrowError(/scratchDir must be covered by policy.allowWrite/);
  });

  it('accepts a scratchDir nested under an allowed write root', () => {
    expect(() =>
      execInputSchema.parse(
        validInput({
          policy: { allowedDomains: [], allowWrite: ['/tmp'] },
          scratchDir: '/tmp/scratch/run-1',
        })
      )
    ).not.toThrow();
  });

  it('requires an AbortSignal so user Stop can reach the process', () => {
    const { signal: _omitted, ...withoutSignal } = validInput();
    expect(() => execInputSchema.parse(withoutSignal)).toThrowError();
    expect(() => execInputSchema.parse({ ...withoutSignal, signal: 'nope' })).toThrowError();
  });

  it('rejects unknown keys', () => {
    expect(() => execInputSchema.parse({ ...validInput(), extra: true })).toThrowError();
  });
});

describe('isPathCoveredBy', () => {
  it('covers exact matches and descendants, not siblings or prefixes', () => {
    expect(isPathCoveredBy('/tmp/scratch', ['/tmp/scratch'])).toBe(true);
    expect(isPathCoveredBy('/tmp/scratch/run', ['/tmp'])).toBe(true);
    expect(isPathCoveredBy('/tmp/scratch', ['/tmp/other'])).toBe(false);
    expect(isPathCoveredBy('/tmp/scratchpad', ['/tmp/scratch'])).toBe(false);
    expect(isPathCoveredBy('/tmp', ['/tmp/scratch'])).toBe(false);
    expect(isPathCoveredBy('/tmp/scratch', [])).toBe(false);
  });

  it('never claims coverage for an unresolved traversal in either operand', () => {
    expect(isPathCoveredBy('/tmp/scratch/../../etc/passwd', ['/tmp/scratch'])).toBe(false);
    expect(isPathCoveredBy('/tmp/scratch/run', ['/tmp/scratch/../..'])).toBe(false);
  });

  it('treats a backslash as a literal filename character on POSIX paths', () => {
    // On POSIX '/tmp/scratch\run' is a SIBLING named 'scratch\run', not a
    // descendant of '/tmp/scratch'.
    expect(isPathCoveredBy('/tmp/scratch\\run', ['/tmp/scratch'])).toBe(false);
    expect(isPathCoveredBy('/tmp/scratch\\run', ['/tmp'])).toBe(true);
  });

  it('folds case for the Windows DRIVE LETTER only, not whole segments', () => {
    // The drive letter is what Node APIs spell inconsistently, so it folds.
    expect(isPathCoveredBy('c:\\work\\scratch', ['C:\\work'])).toBe(true);
    expect(isPathCoveredBy('C:\\work\\scratch', ['c:\\work'])).toBe(true);
    // Directory segments do NOT fold: NTFS supports per-directory case
    // sensitivity (WSL sets it), so folding them could report coverage the
    // filesystem does not grant — a false PERMIT, the unsafe direction.
    // Callers realpath first, which yields the canonical on-disk spelling.
    expect(isPathCoveredBy('C:\\Work\\Scratch', ['c:\\work'])).toBe(false);
    expect(isPathCoveredBy('/tmp/Scratch', ['/tmp/scratch'])).toBe(false);
  });

  it('folds both UNC volume segments (host AND share), but not directories', () => {
    // SMB treats the host and the share name case-insensitively, so both fold;
    // a share name is not a directory on a per-directory-case-sensitive volume.
    expect(isPathCoveredBy('\\\\Server\\Share\\dir', ['\\\\server\\share'])).toBe(true);
    expect(isPathCoveredBy('\\\\server\\share\\dir', ['\\\\SERVER\\SHARE'])).toBe(true);
    // The directory after the share does not fold.
    expect(isPathCoveredBy('\\\\server\\share\\Dir', ['\\\\server\\share\\dir'])).toBe(false);
  });
});

describe('resolveCodeExecutor', () => {
  it('resolves each kind from its own factory', async () => {
    const fenceExecutor = stubExecutor();
    const vmExecutor = stubExecutor({
      ...fenceCapabilities,
      maxIsolationTier: 'vm',
    });
    await expect(resolveCodeExecutor('fence', { fence: () => fenceExecutor })).resolves.toBe(
      fenceExecutor
    );
    await expect(resolveCodeExecutor('vm', { vm: () => vmExecutor })).resolves.toBe(vmExecutor);
  });

  it('awaits construction before checking the isolation tier', async () => {
    const executor = stubExecutor();
    const capabilities = vi.spyOn(executor, 'capabilities');
    const construction = Promise.withResolvers<CodeExecutor>();
    const fence = vi.fn(() => construction.promise);
    const resolution = resolveCodeExecutor('fence', { fence });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(capabilities).not.toHaveBeenCalled();
    construction.resolve(executor);
    await expect(resolution).resolves.toBe(executor);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('forwards the construction abort signal to the selected factory', async () => {
    const controller = new AbortController();
    const executor = stubExecutor();
    const fence = vi.fn(() => Promise.resolve(executor));
    await expect(resolveCodeExecutor('fence', { fence }, controller.signal)).resolves.toBe(
      executor
    );
    expect(fence).toHaveBeenCalledExactlyOnceWith(controller.signal);
  });

  it.each(['fence', 'vm'] as const)(
    'propagates asynchronous %s construction failure without invoking the other factory',
    async (requested) => {
      const failure = new Error('The requested sandbox could not become ready');
      const rejectedConstruction = Promise.reject(failure);
      // The factory owns this promise before the resolver attaches to it.
      void rejectedConstruction.catch(() => undefined);
      const failingFactory = vi.fn(() => rejectedConstruction);
      const otherFactory = vi.fn(stubExecutor);
      const host =
        requested === 'fence'
          ? { fence: failingFactory, vm: otherFactory }
          : { fence: otherFactory, vm: failingFactory };
      await expect(resolveCodeExecutor(requested, host)).rejects.toBe(failure);
      expect(failingFactory).toHaveBeenCalledTimes(1);
      expect(otherFactory).not.toHaveBeenCalled();
    }
  );

  it('propagates a synchronous construction failure as a rejection', async () => {
    const failure = new Error('The factory refused construction');
    const fence = () => {
      throw failure;
    };
    await expect(resolveCodeExecutor('fence', { fence })).rejects.toBe(failure);
  });

  it('never invokes the factory for the other kind', async () => {
    const vm = vi.fn(stubExecutor);
    await resolveCodeExecutor('fence', { fence: () => stubExecutor(), vm });
    expect(vm).not.toHaveBeenCalled();
  });

  it('throws a typed error when vm is requested on a fence-only host', async () => {
    let caught: unknown;
    try {
      await resolveCodeExecutor('vm', { fence: () => stubExecutor() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutorKindUnavailableError);
    if (!isExecutorKindUnavailableError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.requestedKind).toBe('vm');
    expect(caught.availableKinds).toEqual(['fence']);
    expect(caught.code).toBe('executor_kind_unavailable');
  });

  it('throws when fence is requested on a vm-only host (no downgrade in either direction)', async () => {
    const vmExecutor = stubExecutor({
      ...fenceCapabilities,
      maxIsolationTier: 'vm',
    });
    await expect(resolveCodeExecutor('fence', { vm: () => vmExecutor })).rejects.toThrowError(
      ExecutorKindUnavailableError
    );
  });

  it('throws with an empty available list on a host with no backend', async () => {
    let caught: unknown;
    try {
      await resolveCodeExecutor('fence', {});
    } catch (error) {
      caught = error;
    }
    if (!isExecutorKindUnavailableError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.availableKinds).toEqual([]);
  });

  it('rejects an executor whose advertised tier is weaker than the requested kind', async () => {
    let caught: unknown;
    try {
      await resolveCodeExecutor('fence', {
        fence: () => createNullCodeExecutor({ platform: 'darwin' }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutorTierMismatchError);
    if (!isExecutorTierMismatchError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.requestedKind).toBe('fence');
    expect(caught.requiredTier).toBe('os-fence');
    expect(caught.reportedTier).toBe('none');
  });

  it('disposes the asynchronously constructed executor it rejects, so a mis-tiered factory cannot leak', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    await expect(
      resolveCodeExecutor('fence', {
        fence: () =>
          Promise.resolve({ ...createNullCodeExecutor({ platform: 'darwin' }), dispose }),
      })
    ).rejects.toThrowError(ExecutorTierMismatchError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('still reports the tier mismatch when disposing the rejected executor fails', async () => {
    await expect(
      resolveCodeExecutor('fence', {
        fence: () => ({
          ...createNullCodeExecutor({ platform: 'darwin' }),
          dispose: () => Promise.reject(new Error('teardown exploded')),
        }),
      })
    ).rejects.toThrowError(ExecutorTierMismatchError);
  });

  it('rejects a fence-tier executor registered as the vm backend', async () => {
    await expect(resolveCodeExecutor('vm', { vm: () => stubExecutor() })).rejects.toThrowError(
      ExecutorTierMismatchError
    );
  });
});

describe('assertExecRequestSatisfiable', () => {
  it('passes a request the executor can satisfy', () => {
    expect(() => assertExecRequestSatisfiable(fenceCapabilities, validInput())).not.toThrow();
  });

  it('throws when the language is unsupported', () => {
    let caught: unknown;
    try {
      assertExecRequestSatisfiable(fenceCapabilities, validInput({ language: 'bash' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecCapabilityMismatchError);
    if (!isExecCapabilityMismatchError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.reason).toBe('language_unsupported');
  });

  it('throws rather than quietly running with networking off', () => {
    let caught: unknown;
    try {
      assertExecRequestSatisfiable(
        { ...fenceCapabilities, supportsNetwork: false },
        validInput({
          policy: {
            allowedDomains: ['api.github.com'],
            allowWrite: ['/tmp/scratch'],
          },
        })
      );
    } catch (error) {
      caught = error;
    }
    if (!isExecCapabilityMismatchError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.reason).toBe('network_unsupported');
  });

  it('allows a no-network request against a no-network executor', () => {
    expect(() =>
      assertExecRequestSatisfiable({ ...fenceCapabilities, supportsNetwork: false }, validInput())
    ).not.toThrow();
  });
});

describe('isExecResultTruncated', () => {
  it('reports per-stream omission', () => {
    const base = {
      exitCode: 0,
      signal: null,
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: '',
      stdoutOmittedBytes: 0,
      timedOut: false,
    };
    expect(isExecResultTruncated(base)).toBe(false);
    expect(isExecResultTruncated({ ...base, stdoutOmittedBytes: 12 })).toBe(true);
    expect(isExecResultTruncated({ ...base, stderrOmittedBytes: 12 })).toBe(true);
  });
});

describe('createNullCodeExecutor', () => {
  it('advertises honest capabilities: no isolation, no network, no languages', () => {
    expect(createNullCodeExecutor({ platform: 'darwin' }).capabilities()).toEqual({
      languages: [],
      maxIsolationTier: 'none',
      platform: 'darwin',
      supportsNetwork: false,
    });
  });

  it('rejects every execute call with a typed no-sandbox error and runs nothing', async () => {
    const executor = createNullCodeExecutor({ platform: 'linux' });
    const attempt = executor.execute(validInput());
    await expect(attempt).rejects.toBeInstanceOf(NoSandboxConfiguredError);
    await expect(attempt).rejects.toMatchObject({
      code: 'no_sandbox_configured',
    });
  });

  it('dispose resolves and is idempotent', async () => {
    const executor = createNullCodeExecutor({ platform: 'win32' });
    await expect(executor.dispose()).resolves.toBeUndefined();
    await expect(executor.dispose()).resolves.toBeUndefined();
  });
});

describe('ExecAbortedError', () => {
  // Cancellation is an error, not a result: `exitCode: null, timedOut: false`
  // would differ from a timeout only by the ABSENCE of a flag, forcing every
  // consumer to reverse-engineer the intent.
  it('reports the queued position as nothing having run', () => {
    const error = new ExecAbortedError({ processStarted: false });
    expect(isExecAbortedError(error)).toBe(true);
    expect(error.code).toBe('exec_aborted');
    expect(error.name).toBe('ExecAbortedError');
    expect(error.processStarted).toBe(false);
    expect(error.message).toMatch(/before any process started/i);
    expect(error.partialStdout).toBe('');
    expect(error.partialStderr).toBe('');
    expect(error.stdoutOmittedBytes).toBe(0);
    expect(error.stderrOmittedBytes).toBe(0);
  });

  it('carries the partial output when the process had already started', () => {
    const error = new ExecAbortedError({
      partialStderr: 'warn',
      partialStdout: 'half a line',
      processStarted: true,
      stderrOmittedBytes: 3,
      stdoutOmittedBytes: 12,
    });
    expect(error.processStarted).toBe(true);
    expect(error.partialStdout).toBe('half a line');
    expect(error.partialStderr).toBe('warn');
    expect(error.stdoutOmittedBytes).toBe(12);
    expect(error.stderrOmittedBytes).toBe(3);
    expect(error.message).toMatch(/process tree was terminated/i);
  });

  it('is an Error, so one catch covers both positions', () => {
    expect(new ExecAbortedError({ processStarted: true })).toBeInstanceOf(Error);
    expect(isExecAbortedError(new Error('nope'))).toBe(false);
    expect(isExecAbortedError(undefined)).toBe(false);
  });
});
