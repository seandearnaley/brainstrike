import { EventEmitter } from 'node:events';
import { platform } from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeExecutor, ExecInput } from '../code-execution';

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
const mocks = vi.hoisted(() => ({ rm: vi.fn(), spawn: vi.fn() }));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandbox }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rm: mocks.rm,
}));
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

import { createFenceExecutor } from '../fence/fence-executor';

const interpreters = { python: { command: '/usr/bin/python3', scriptExtension: 'py' } } as const;
const childProcess = () =>
  Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
const finish = (child: ReturnType<typeof childProcess>, stderr = ''): void => {
  child.stdout.emit('data', Buffer.from('brainstrike-fence-ready'));
  child.stderr.emit('data', Buffer.from(stderr));
  child.emit('exit', stderr ? 1 : 0, null);
  child.emit('close', stderr ? 1 : 0, null);
};
const input = (): ExecInput => ({
  code: 'print(1)',
  language: 'python',
  maxOutputBytes: 1024,
  policy: { allowedDomains: [], allowWrite: ['/tmp'] },
  scratchDir: '/tmp',
  signal: new AbortController().signal,
  timeoutMs: 30_000,
});

beforeEach(() => {
  mocks.rm.mockImplementation(actualFs.rm);
  mocks.spawn.mockImplementation(() => {
    const child = childProcess();
    queueMicrotask(() => finish(child));
    return child;
  });
  sandbox.checkDependenciesAsync.mockResolvedValue({ errors: [], warnings: [] });
  sandbox.cleanupAfterCommand.mockReset();
  sandbox.reset.mockResolvedValue(undefined);
});

describe.skipIf(platform !== 'linux' && platform !== 'darwin')(
  'readiness queue and handoff',
  () => {
    it('allows construction to wait behind an execution longer than the probe ceiling', async () => {
      const first = await createFenceExecutor({ interpreters });
      const runningChild = childProcess();
      mocks.spawn.mockReturnValueOnce(runningChild);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let second: CodeExecutor | undefined;
      let settled = false;
      let constructionError: unknown;
      try {
        const execution = first.execute(input());
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        const queued = createFenceExecutor({ interpreters }).then(
          (executor) => {
            second = executor;
            settled = true;
          },
          (error: unknown) => {
            constructionError = error;
            settled = true;
          }
        );
        await vi.advanceTimersByTimeAsync(6000);
        const settledWhileQueued = settled;
        const checksWhileQueued = sandbox.checkDependenciesAsync.mock.calls.length;
        finish(runningChild);
        await execution;
        await queued;
        expect(settledWhileQueued).toBe(false);
        expect(checksWhileQueued).toBe(1);
        expect(constructionError).toBeUndefined();
        expect(second).toBeDefined();
      } finally {
        finish(runningChild);
        await second?.dispose();
        await first.dispose();
        vi.useRealTimers();
      }
    });

    it('honours the caller budget while queued without checking the busy host', async () => {
      const first = await createFenceExecutor({ interpreters });
      const runningChild = childProcess();
      mocks.spawn.mockReturnValueOnce(runningChild);
      const controller = new AbortController();
      const reason = new Error('tool budget exhausted');
      try {
        const execution = first.execute(input());
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
        const queued = createFenceExecutor({ interpreters }, controller.signal);
        const rejected = expect(queued).rejects.toBe(reason);
        controller.abort(reason);
        await rejected;
        expect(sandbox.checkDependenciesAsync).toHaveBeenCalledTimes(1);
        finish(runningChild);
        await execution;
      } finally {
        finish(runningChild);
        await first.dispose();
      }
      expect(sandbox.reset).toHaveBeenCalledTimes(1);
    });

    // Sweep the microtasks between scratch cleanup, probe completion and factory
    // handoff. Both cancellation and a returned/disposed executor must release
    // their lease; resetting modules here would conceal a leaked refcount.
    it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
      'releases a lease when aborted %i microtasks after cleanup',
      async (depth) => {
        const controller = new AbortController();
        const reason = new Error('Stopped at handoff');
        mocks.rm.mockImplementationOnce(async (...args: Parameters<typeof actualFs.rm>) => {
          await actualFs.rm(...args);
          let remaining = depth;
          const abort = (): void => {
            if (remaining-- === 0) {
              controller.abort(reason);
            } else {
              queueMicrotask(abort);
            }
          };
          queueMicrotask(abort);
        });
        const result = await createFenceExecutor({ interpreters }, controller.signal).then(
          (executor) => ({ executor }),
          (error: unknown) => ({ error })
        );
        if ('executor' in result) {
          await result.executor.dispose();
        } else {
          expect(result.error).toBe(reason);
        }
        const retried = await createFenceExecutor({ interpreters });
        await retried.dispose();
        expect(sandbox.reset).toHaveBeenCalled();
      }
    );
  }
);

describe.skipIf(platform !== 'linux' && platform !== 'darwin')(
  'readiness diagnostic preservation',
  () => {
    it('refuses an unrelated runtime warning and includes its bounded actual diagnostic', async () => {
      const warning = `runtime feature unavailable: ${'x'.repeat(2000)}`;
      sandbox.checkDependenciesAsync.mockResolvedValue({ errors: [], warnings: [warning] });
      const rejected = createFenceExecutor({ interpreters });
      await expect(rejected).rejects.toMatchObject({
        message: expect.stringContaining(warning.slice(0, 1024)),
        reason: 'sandbox_unsupported_runtime',
      });
      await expect(rejected).rejects.not.toMatchObject({
        message: expect.stringContaining(warning),
      });
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each(['command', 'scratch', 'reset'] as const)(
      'preserves namespace denial when %s cleanup also fails',
      async (stage) => {
        const cleanupError = new Error(`${stage} cleanup failed`);
        if (stage === 'command') {
          sandbox.cleanupAfterCommand.mockImplementationOnce(() => {
            throw cleanupError;
          });
        }
        if (stage === 'scratch') {
          mocks.rm.mockImplementationOnce(async (...args: Parameters<typeof actualFs.rm>) => {
            await actualFs.rm(...args);
            throw cleanupError;
          });
        }
        if (stage === 'reset') {
          sandbox.reset.mockRejectedValueOnce(cleanupError);
        }
        mocks.spawn.mockImplementationOnce(() => {
          const child = childProcess();
          queueMicrotask(() =>
            finish(child, 'bwrap: Creating new namespace failed: Operation not permitted')
          );
          return child;
        });
        await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
          cause: { errors: expect.arrayContaining([cleanupError]) },
          reason: platform === 'linux' ? 'sandbox_namespace_blocked' : 'sandbox_readiness_failed',
        });
        expect(sandbox.cleanupAfterCommand).toHaveBeenCalledTimes(1);
        expect(mocks.rm).toHaveBeenCalledTimes(1);
      }
    );

    it('fails closed if an otherwise successful probe cannot clean up', async () => {
      sandbox.cleanupAfterCommand.mockImplementationOnce(() => {
        throw new Error('cleanup failed');
      });
      await expect(createFenceExecutor({ interpreters })).rejects.toMatchObject({
        reason: 'sandbox_readiness_failed',
      });
      expect(mocks.rm).toHaveBeenCalledTimes(1);
      expect(sandbox.reset).toHaveBeenCalledTimes(1);
    });
  }
);
