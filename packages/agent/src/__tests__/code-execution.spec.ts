import { describe, expect, it, vi } from 'vitest';

import {
  assertExecRequestSatisfiable,
  type CodeExecutor,
  createNullCodeExecutor,
  ExecCapabilityMismatchError,
  type ExecInput,
  type ExecutorCapabilities,
  ExecutorKindUnavailableError,
  ExecutorTierMismatchError,
  execInputSchema,
  execPolicySchema,
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

  it.each([
    'docker',
    '',
    'FENCE',
    0,
    null,
    undefined,
    {},
    Symbol('fence'),
  ])('throws the contracted error on unsupported value %j', (value) => {
    expect(() => parseExecutorKind(value)).toThrowError(/not a supported code-execution mode/);
  });

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

  it.each([
    'not a domain!',
    'http://example.com',
    '*.*',
    'exa mple.com',
    '*.com',
    '*.io',
  ])('rejects malformed or over-broad domain %j', (domain) => {
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: [domain],
        allowWrite: ['/tmp/scratch'],
      })
    ).toThrowError();
  });

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

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_EXEC_TIMEOUT_MS + 1,
  ])('rejects timeoutMs %j', (timeoutMs) => {
    expect(() =>
      execInputSchema.parse(validInput({ timeoutMs } as Partial<ExecInput>))
    ).toThrowError();
  });

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

  it('folds case for Windows-shaped paths only', () => {
    expect(isPathCoveredBy('c:\\work\\scratch', ['C:\\work'])).toBe(true);
    expect(isPathCoveredBy('C:\\Work\\Scratch', ['c:\\work'])).toBe(true);
    expect(isPathCoveredBy('/tmp/Scratch', ['/tmp/scratch'])).toBe(false);
  });
});

describe('resolveCodeExecutor', () => {
  it('resolves each kind from its own factory', () => {
    const fenceExecutor = stubExecutor();
    const vmExecutor = stubExecutor({
      ...fenceCapabilities,
      maxIsolationTier: 'vm',
    });
    expect(resolveCodeExecutor('fence', { fence: () => fenceExecutor })).toBe(fenceExecutor);
    expect(resolveCodeExecutor('vm', { vm: () => vmExecutor })).toBe(vmExecutor);
  });

  it('never invokes the factory for the other kind', () => {
    const vm = vi.fn(stubExecutor);
    resolveCodeExecutor('fence', { fence: () => stubExecutor(), vm });
    expect(vm).not.toHaveBeenCalled();
  });

  it('throws a typed error when vm is requested on a fence-only host', () => {
    let caught: unknown;
    try {
      resolveCodeExecutor('vm', { fence: () => stubExecutor() });
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

  it('throws when fence is requested on a vm-only host (no downgrade in either direction)', () => {
    const vmExecutor = stubExecutor({
      ...fenceCapabilities,
      maxIsolationTier: 'vm',
    });
    expect(() => resolveCodeExecutor('fence', { vm: () => vmExecutor })).toThrowError(
      ExecutorKindUnavailableError
    );
  });

  it('throws with an empty available list on a host with no backend', () => {
    let caught: unknown;
    try {
      resolveCodeExecutor('fence', {});
    } catch (error) {
      caught = error;
    }
    if (!isExecutorKindUnavailableError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.availableKinds).toEqual([]);
  });

  it('rejects an executor whose advertised tier is weaker than the requested kind', () => {
    let caught: unknown;
    try {
      resolveCodeExecutor('fence', {
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

  it('disposes the executor it rejects, so a mis-tiered factory cannot leak', () => {
    const dispose = vi.fn(() => Promise.resolve());
    expect(() =>
      resolveCodeExecutor('fence', {
        fence: () => ({ ...createNullCodeExecutor({ platform: 'darwin' }), dispose }),
      })
    ).toThrowError(ExecutorTierMismatchError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('still reports the tier mismatch when disposing the rejected executor fails', () => {
    expect(() =>
      resolveCodeExecutor('fence', {
        fence: () => ({
          ...createNullCodeExecutor({ platform: 'darwin' }),
          dispose: () => Promise.reject(new Error('teardown exploded')),
        }),
      })
    ).toThrowError(ExecutorTierMismatchError);
  });

  it('rejects a fence-tier executor registered as the vm backend', () => {
    expect(() => resolveCodeExecutor('vm', { vm: () => stubExecutor() })).toThrowError(
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
