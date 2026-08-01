import { describe, expect, it, vi } from 'vitest';

import {
  type CodeExecutor,
  createNullCodeExecutor,
  ExecutorKindUnavailableError,
  execPolicySchema,
  isExecutorKindUnavailableError,
  isNoSandboxConfiguredError,
  NoSandboxConfiguredError,
  parseExecutorKind,
  resolveCodeExecutor,
} from '../code-execution';

const stubExecutor = (): CodeExecutor => ({
  capabilities: () => ({
    languages: ['python'],
    maxIsolationTier: 'os-fence',
    platform: 'darwin',
    supportsNetwork: true,
  }),
  dispose: () => Promise.resolve(),
  execute: () =>
    Promise.resolve({
      exitCode: 0,
      stderr: '',
      stdout: '',
      timedOut: false,
      truncated: false,
    }),
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
  ])('throws on unsupported value %j', (value) => {
    expect(() => parseExecutorKind(value)).toThrowError(/not a supported code-execution mode/);
  });
});

describe('execPolicySchema', () => {
  it('parses a full policy', () => {
    const policy = execPolicySchema.parse({
      allowedDomains: ['api.github.com'],
      allowRead: ['/opt/data'],
      allowWrite: ['/tmp/scratch'],
      denyRead: ['/Users/someone/.ssh'],
    });
    expect(policy.allowWrite).toEqual(['/tmp/scratch']);
    expect(policy.allowedDomains).toEqual(['api.github.com']);
  });

  it('accepts an empty allowedDomains list (no network)', () => {
    const policy = execPolicySchema.parse({
      allowedDomains: [],
      allowWrite: ['/tmp/scratch'],
    });
    expect(policy.allowedDomains).toEqual([]);
    expect(policy.allowRead).toBeUndefined();
    expect(policy.denyRead).toBeUndefined();
  });

  it('rejects a policy missing allowWrite', () => {
    expect(() => execPolicySchema.parse({ allowedDomains: [] })).toThrowError();
  });

  it('rejects a policy missing allowedDomains', () => {
    expect(() => execPolicySchema.parse({ allowWrite: ['/tmp/scratch'] })).toThrowError();
  });

  it('rejects unknown keys instead of stripping them', () => {
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: [],
        allowNetwork: true,
        allowWrite: ['/tmp/scratch'],
      })
    ).toThrowError();
  });

  it('rejects non-string path entries', () => {
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: [],
        allowWrite: [42],
      })
    ).toThrowError();
  });

  it('rejects blank path and domain entries', () => {
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: [],
        allowWrite: ['  '],
      })
    ).toThrowError();
    expect(() =>
      execPolicySchema.parse({
        allowedDomains: [''],
        allowWrite: ['/tmp/scratch'],
      })
    ).toThrowError();
  });
});

describe('resolveCodeExecutor', () => {
  it('resolves fence when the host provides a fence factory', () => {
    const executor = stubExecutor();
    const fence = vi.fn(() => executor);
    expect(resolveCodeExecutor('fence', { fence })).toBe(executor);
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it('resolves vm when the host provides a vm factory', () => {
    const executor = stubExecutor();
    const vm = vi.fn(() => executor);
    expect(resolveCodeExecutor('vm', { vm })).toBe(executor);
    expect(vm).toHaveBeenCalledTimes(1);
  });

  it('never invokes the factory for the other kind', () => {
    const fence = vi.fn(stubExecutor);
    const vm = vi.fn(stubExecutor);
    resolveCodeExecutor('fence', { fence, vm });
    expect(vm).not.toHaveBeenCalled();
  });

  it('throws a typed error when vm is requested on a fence-only host', () => {
    let caught: unknown;
    try {
      resolveCodeExecutor('vm', { fence: stubExecutor });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutorKindUnavailableError);
    expect(isExecutorKindUnavailableError(caught)).toBe(true);
    if (!isExecutorKindUnavailableError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.requestedKind).toBe('vm');
    expect(caught.availableKinds).toEqual(['fence']);
    expect(caught.code).toBe('executor_kind_unavailable');
    expect(caught.message).toContain('vm');
  });

  it('throws when fence is requested on a vm-only host (no downgrade in either direction)', () => {
    expect(() => resolveCodeExecutor('fence', { vm: stubExecutor })).toThrowError(
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
    expect(isExecutorKindUnavailableError(caught)).toBe(true);
    if (!isExecutorKindUnavailableError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.availableKinds).toEqual([]);
  });
});

describe('createNullCodeExecutor', () => {
  it('advertises honest capabilities: no isolation, no network, no languages', () => {
    const executor = createNullCodeExecutor({ platform: 'darwin' });
    expect(executor.capabilities()).toEqual({
      languages: [],
      maxIsolationTier: 'none',
      platform: 'darwin',
      supportsNetwork: false,
    });
  });

  it('rejects every execute call with a typed no-sandbox error and runs nothing', async () => {
    const executor = createNullCodeExecutor({ platform: 'linux' });
    const attempt = executor.execute({
      code: 'print("hi")',
      language: 'python',
      policy: { allowedDomains: [], allowWrite: ['/tmp/scratch'] },
      scratchDir: '/tmp/scratch',
      timeoutMs: 1000,
    });
    await expect(attempt).rejects.toBeInstanceOf(NoSandboxConfiguredError);
    await expect(attempt).rejects.toMatchObject({
      code: 'no_sandbox_configured',
    });
    await expect(attempt).rejects.toThrowError(/no code-execution sandbox/i);
  });

  it('dispose resolves and is idempotent', async () => {
    const executor = createNullCodeExecutor({ platform: 'win32' });
    await expect(executor.dispose()).resolves.toBeUndefined();
    await expect(executor.dispose()).resolves.toBeUndefined();
  });

  it('lets tool code reach the seam end to end with no backend installed', async () => {
    // Integration-shaped: the host wires the stub while real backends are
    // being built; tool code resolves through the normal seam and receives
    // the typed structured error, never a fabricated ExecResult.
    const executor = resolveCodeExecutor('fence', {
      fence: () => createNullCodeExecutor({ platform: 'darwin' }),
    });
    let caught: unknown;
    try {
      await executor.execute({
        code: 'import os',
        language: 'python',
        policy: { allowedDomains: [], allowWrite: ['/tmp/scratch'] },
        scratchDir: '/tmp/scratch',
        timeoutMs: 5000,
      });
    } catch (error) {
      caught = error;
    }
    expect(isNoSandboxConfiguredError(caught)).toBe(true);
  });
});
