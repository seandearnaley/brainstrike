import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeExecutor, ExecInput } from '../code-execution';
import type { FenceExecutorOptions } from '../fence/fence-executor';

const runtime = vi.hoisted(() => ({ config: undefined as SandboxRuntimeConfig | undefined }));
const sandbox = vi.hoisted(() => ({
  checkDependenciesAsync: vi.fn(async () => ({ errors: [] as string[], warnings: [] as string[] })),
  cleanupAfterCommand: vi.fn(),
  initialize: vi.fn(async (_config: SandboxRuntimeConfig) => {}),
  isSupportedPlatform: vi.fn(() => true),
  reset: vi.fn(async () => {}),
  updateConfig: vi.fn((config: SandboxRuntimeConfig) => {
    runtime.config = config;
  }),
  wrapWithSandboxArgv: vi.fn(
    async (command: string, _shell?: string, _config?: SandboxRuntimeConfig) => ({
      argv: ['/bin/sh', '-c', command],
      env: {},
    })
  ),
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandbox }));
const spawnProbe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnProbe }));
const helperAccess = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  helperAccess.mockImplementation(actual.access);
  return { ...actual, access: helperAccess };
});

const realpathNative = promisify(realpath.native);
const interpreters = { python: { command: '/usr/bin/python3', scriptExtension: 'py' } } as const;
let scratch: string;
let firstPath: string;
let secondPath: string;
const executors: CodeExecutor[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('node:process', async () => {
    const actual = await vi.importActual<typeof import('node:process')>('node:process');
    return { ...actual, default: actual, platform: 'linux' };
  });
  runtime.config = undefined;
  sandbox.checkDependenciesAsync.mockResolvedValue({ errors: [], warnings: [] });
  scratch = await realpathNative(await mkdtemp(join(tmpdir(), 'brainstrike-fence-helper-')));
  firstPath = join(scratch, "first helper's apply-seccomp");
  secondPath = join(scratch, 'second-apply-seccomp');
  await Promise.all(
    [firstPath, secondPath].map((path) => writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 }))
  );
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

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.dispose()));
  await rm(scratch, { force: true, recursive: true });
  vi.doUnmock('node:process');
});

async function create(options: FenceExecutorOptions, signal?: AbortSignal): Promise<CodeExecutor> {
  const { createFenceExecutor } = await import('../fence/fence-executor');
  const { configureLogger } = await import('@brainstrike/logging');
  configureLogger({ console: false });
  const executor = await createFenceExecutor(options, signal);
  executors.push(executor);
  return executor;
}

function request(allowedDomains: string[] = []): ExecInput {
  return {
    code: 'print(1)',
    language: 'python',
    maxOutputBytes: 4096,
    policy: { allowedDomains, allowWrite: [scratch] },
    scratchDir: scratch,
    signal: new AbortController().signal,
    timeoutMs: 1000,
  };
}

describe('trusted Linux seccomp helper injection', () => {
  it.each(['', 'apply-seccomp', './apply-seccomp', '~/apply-seccomp', '/tmp/invalid\0helper'])(
    'rejects malformed helper paths before touching sandbox state: %j',
    async (linuxSeccompApplyPath) => {
      await expect(create({ interpreters, linuxSeccompApplyPath })).rejects.toMatchObject({
        code: 'fence_invalid_request',
      });
      expect(sandbox.updateConfig).not.toHaveBeenCalled();
      expect(sandbox.checkDependenciesAsync).not.toHaveBeenCalled();
      expect(spawnProbe).not.toHaveBeenCalled();
    }
  );

  it('installs the exact restrictive helper config before checking dependencies and uses it for both wrappers', async () => {
    let checkedConfig: SandboxRuntimeConfig | undefined;
    sandbox.checkDependenciesAsync.mockImplementation(async () => {
      checkedConfig = runtime.config;
      return runtime.config?.seccomp?.applyPath === firstPath
        ? { errors: [], warnings: [] }
        : { errors: [], warnings: ['the configured helper is unavailable'] };
    });
    const executor = await create({ interpreters, linuxSeccompApplyPath: firstPath });
    expect(checkedConfig?.seccomp).toEqual({ applyPath: firstPath });
    expect(checkedConfig?.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    expect(checkedConfig?.filesystem.allowWrite).toEqual([
      expect.stringContaining('brainstrike-fence-readiness-'),
      expect.stringContaining('brainstrike-fence-readiness-'),
    ]);
    expect(sandbox.initialize).toHaveBeenCalledWith(checkedConfig);
    expect(sandbox.initialize.mock.invocationCallOrder[0]).toBeGreaterThan(
      sandbox.checkDependenciesAsync.mock.invocationCallOrder[0] ?? 0
    );
    expect(sandbox.wrapWithSandboxArgv.mock.calls[0]?.[2]).toEqual(checkedConfig);
    await executor.execute(request());
    expect(sandbox.wrapWithSandboxArgv.mock.calls[1]?.[2]?.seccomp).toEqual({
      applyPath: firstPath,
    });
    expect(runtime.config?.seccomp).toEqual({ applyPath: firstPath });
  });

  it.each(['missing', 'not executable'] as const)(
    'refuses an explicit helper that is %s without letting the runtime fall back',
    async (failure) => {
      if (failure === 'missing') {
        await rm(firstPath);
      } else {
        await chmod(firstPath, 0o600);
      }
      await expect(
        create({ interpreters, linuxSeccompApplyPath: firstPath })
      ).rejects.toMatchObject({
        code: 'fence_readiness_unavailable',
        reason: 'sandbox_dependencies_missing',
      });
      expect(sandbox.checkDependenciesAsync).not.toHaveBeenCalled();
      expect(sandbox.initialize).not.toHaveBeenCalled();
      expect(sandbox.wrapWithSandboxArgv).not.toHaveBeenCalled();
      expect(spawnProbe).not.toHaveBeenCalled();
    }
  );

  it.each(['directory', 'virtual ASAR', 'symlink into ASAR'] as const)(
    'refuses a helper that is a %s even if host fs checks could accept it',
    async (kind) => {
      const archive = join(scratch, 'app.asar');
      await mkdir(archive);
      const archivedHelper = join(archive, 'apply-seccomp');
      await writeFile(archivedHelper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const alias = join(scratch, 'aliased-helper');
      await symlink(archivedHelper, alias);
      const linuxSeccompApplyPath =
        kind === 'directory' ? scratch : kind === 'virtual ASAR' ? archivedHelper : alias;
      await expect(create({ interpreters, linuxSeccompApplyPath })).rejects.toMatchObject({
        reason: 'sandbox_dependencies_missing',
      });
      expect(sandbox.checkDependenciesAsync).not.toHaveBeenCalled();
      expect(spawnProbe).not.toHaveBeenCalled();
    }
  );

  it('still refuses all runtime warnings with an explicit helper before initialization or spawn', async () => {
    sandbox.checkDependenciesAsync.mockResolvedValue({
      errors: [],
      warnings: ['seccomp not available - unix socket access not restricted'],
    });
    await expect(create({ interpreters, linuxSeccompApplyPath: firstPath })).rejects.toMatchObject({
      reason: 'sandbox_unsupported_runtime',
    });
    expect(runtime.config?.seccomp).toEqual({ applyPath: firstPath });
    expect(sandbox.initialize).not.toHaveBeenCalled();
    expect(spawnProbe).not.toHaveBeenCalled();
  });

  it('passes the canonical helper target even if its symlink changes before runtime lookup', async () => {
    const alias = join(scratch, 'helper-alias');
    await symlink(firstPath, alias);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    helperAccess.mockImplementationOnce(async (...args: Parameters<typeof actual.access>) => {
      await actual.access(...args);
      await rm(alias);
      await symlink(secondPath, alias);
    });
    const executor = await create({ interpreters, linuxSeccompApplyPath: alias });
    expect(runtime.config?.seccomp).toEqual({ applyPath: firstPath });
    expect(sandbox.wrapWithSandboxArgv.mock.calls[0]?.[2]?.seccomp).toEqual({
      applyPath: firstPath,
    });
    await executor.execute(request());
    expect(sandbox.wrapWithSandboxArgv.mock.calls[1]?.[2]?.seccomp).toEqual({
      applyPath: secondPath,
    });
  });

  it.each([false, true])(
    'refuses an exhausted budget after held helper validation, with cancellation precedence: %s',
    async (cancelled) => {
      const executor = await create({ interpreters, linuxSeccompApplyPath: firstPath });
      const entered = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<void>();
      helperAccess.mockImplementationOnce(async () => {
        entered.resolve();
        await stalled.promise;
      });
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(2000);
        const pending = executor.execute({ ...request(), signal: controller.signal });
        const failure = expect(pending).rejects.toMatchObject(
          cancelled
            ? { code: 'exec_aborted', processStarted: false }
            : { code: 'fence_queue_timeout', timeoutMs: 1000 }
        );
        await entered.promise;
        vi.setSystemTime(3001);
        if (cancelled) {
          controller.abort(new Error('Stopped while checking helper'));
        }
        stalled.resolve();
        await failure;
        expect(sandbox.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
        expect(spawnProbe).toHaveBeenCalledTimes(1);
      } finally {
        stalled.resolve();
        vi.useRealTimers();
      }
    }
  );

  it('refuses a helper removed after readiness before execution can fall back', async () => {
    const executor = await create({ interpreters, linuxSeccompApplyPath: firstPath });
    await rm(firstPath);
    await expect(executor.execute(request())).rejects.toMatchObject({
      reason: 'sandbox_dependencies_missing',
    });
    expect(sandbox.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
    expect(spawnProbe).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)(
    'preserves execution cancellation while helper validation settles with %s',
    async (outcome) => {
      const executor = await create({ interpreters, linuxSeccompApplyPath: firstPath });
      const entered = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<void>();
      helperAccess.mockImplementationOnce(async () => {
        entered.resolve();
        await stalled.promise;
      });
      const controller = new AbortController();
      const pending = executor.execute({ ...request(), signal: controller.signal });
      const cancelled = expect(pending).rejects.toMatchObject({
        code: 'exec_aborted',
        processStarted: false,
      });
      await entered.promise;
      controller.abort(new Error('Stopped while checking helper'));
      if (outcome === 'success') {
        stalled.resolve();
      } else {
        stalled.reject(new Error('Helper became unavailable'));
      }
      await cancelled;
      expect(sandbox.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
      expect(spawnProbe).toHaveBeenCalledTimes(1);
    }
  );

  it('replaces stale singleton config and keeps each executor helper private, including omission', async () => {
    const dependencyConfigs: (SandboxRuntimeConfig | undefined)[] = [];
    sandbox.checkDependenciesAsync.mockImplementation(async () => {
      dependencyConfigs.push(runtime.config);
      return { errors: [], warnings: [] };
    });
    const first = await create({ interpreters, linuxSeccompApplyPath: firstPath });
    await first.execute(request(['example.com']));
    const second = await create({ interpreters, linuxSeccompApplyPath: secondPath });
    const omitted = await create({ interpreters });
    expect(dependencyConfigs.map((config) => config?.seccomp)).toEqual([
      { applyPath: firstPath },
      { applyPath: secondPath },
      undefined,
    ]);
    expect(dependencyConfigs.map((config) => config?.network.allowedDomains)).toEqual([[], [], []]);
    await first.execute(request());
    expect(runtime.config?.seccomp).toEqual({ applyPath: firstPath });
    await second.execute(request());
    expect(runtime.config?.seccomp).toEqual({ applyPath: secondPath });
    await omitted.execute(request());
    expect(runtime.config?.seccomp).toBeUndefined();
    expect(sandbox.initialize).toHaveBeenCalledTimes(1);
  });

  it('retains the global lock after cancellation until the configured dependency check joins', async () => {
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    sandbox.checkDependenciesAsync.mockImplementationOnce(async () => {
      entered.resolve();
      await stalled.promise;
      return { errors: [], warnings: [] };
    });
    const controller = new AbortController();
    const reason = new Error('Stopped during dependency check');
    const pending = create({ interpreters, linuxSeccompApplyPath: firstPath }, controller.signal);
    const cancelled = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await cancelled;
    const updatesBeforeRetry = sandbox.updateConfig.mock.calls.length;
    const retried = create({ interpreters, linuxSeccompApplyPath: secondPath });
    try {
      await Promise.resolve();
      expect(sandbox.updateConfig).toHaveBeenCalledTimes(updatesBeforeRetry);
      expect(sandbox.reset).not.toHaveBeenCalled();
      expect(spawnProbe).not.toHaveBeenCalled();
    } finally {
      stalled.resolve();
      await retried;
    }
    expect(runtime.config?.seccomp).toEqual({ applyPath: secondPath });
    expect(spawnProbe).toHaveBeenCalledTimes(1);
    expect(sandbox.reset).toHaveBeenCalledTimes(1);
  });

  it('captures the validated helper path instead of rereading mutable caller options', async () => {
    const options = { interpreters, linuxSeccompApplyPath: firstPath };
    const executor = await create(options);
    options.linuxSeccompApplyPath = secondPath;
    await executor.execute(request());
    expect(runtime.config?.seccomp).toEqual({ applyPath: firstPath });
  });

  it('leaves Darwin config unchanged even when a Linux helper was supplied', async () => {
    vi.doMock('node:process', async () => {
      const actual = await vi.importActual<typeof import('node:process')>('node:process');
      return { ...actual, default: actual, platform: 'darwin' };
    });
    await rm(firstPath);
    const executor = await create({ interpreters, linuxSeccompApplyPath: firstPath });
    await executor.execute(request());
    expect(sandbox.updateConfig.mock.calls.every(([config]) => config.seccomp === undefined)).toBe(
      true
    );
    expect(
      sandbox.wrapWithSandboxArgv.mock.calls.every(([, , config]) => config?.seccomp === undefined)
    ).toBe(true);
  });
});
