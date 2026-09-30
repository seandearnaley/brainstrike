import fsPromises from 'node:fs/promises';
import { noopObserve } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import type {
  CodeExecutor,
  CodeExecutorHostCapabilities,
  ExecInput,
  ExecResult,
} from '../code-execution';
import { FenceReadinessError, type FenceReadinessReason } from '../fence/fence-readiness-error';
import { createRunPythonTool } from '../tools/run-python-tool';

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    signal: null,
    stderr: '',
    stderrOmittedBytes: 0,
    stdout: '',
    stdoutOmittedBytes: 0,
    timedOut: false,
    ...overrides,
  };
}

function stubFence(behaviour: () => Promise<ExecResult>) {
  const inputs: ExecInput[] = [];
  const dispose = vi.fn(async () => undefined);
  const executor: CodeExecutor = {
    capabilities: () => ({
      languages: ['python'],
      maxIsolationTier: 'os-fence',
      platform: 'linux',
      supportsNetwork: true,
    }),
    dispose,
    execute: (input) => {
      inputs.push(input);
      return behaviour();
    },
  };
  return { dispose, executor, inputs };
}

async function runTool(
  host: CodeExecutorHostCapabilities,
  input: { code: string; timeoutMs?: number },
  context?: { abortSignal?: AbortSignal }
) {
  const tool = createRunPythonTool({
    resolveApprovalDecision: () => 'allow',
    resolveHost: () => Promise.resolve(host),
  });
  if (!tool.execute) {
    throw new Error('run_python has no execute handler');
  }
  return await tool.execute(input, { ...context, observe: noopObserve });
}

describe('run_python sandbox construction', () => {
  it('recognizes readiness errors from a separately bundled fence entrypoint', async () => {
    const detail = 'Linux denied sandbox namespace creation. Check the host namespace policy.';
    const failure = Object.assign(new Error(detail), {
      code: 'fence_readiness_unavailable',
      reason: 'sandbox_namespace_blocked',
    });
    await expect(
      runTool({ fence: () => Promise.reject(failure) }, { code: 'pass' })
    ).resolves.toEqual({ detail, kind: 'unavailable', reason: 'sandbox_namespace_blocked' });
  });

  it('awaits asynchronous executor construction before creating scratch space or running code', async () => {
    const stub = stubFence(async () => execResult({ stdout: 'ready\n' }));
    const construction = Promise.withResolvers<CodeExecutor>();
    const started = Promise.withResolvers<void>();
    const mkdtemp = vi.spyOn(fsPromises, 'mkdtemp');
    const run = runTool(
      {
        fence: () => {
          started.resolve();
          return construction.promise;
        },
      },
      { code: 'print("ready")' }
    );
    try {
      await started.promise;
      expect(stub.inputs).toHaveLength(0);
      expect(mkdtemp).not.toHaveBeenCalled();
      construction.resolve(stub.executor);
      await expect(run).resolves.toMatchObject({ kind: 'completed', stdout: 'ready\n' });
      expect(stub.inputs).toHaveLength(1);
      expect(stub.dispose).toHaveBeenCalledTimes(1);
    } finally {
      construction.resolve(stub.executor);
      await run.catch(() => undefined);
      mkdtemp.mockRestore();
    }
  });

  it('refuses to run when asynchronous executor construction consumed the whole budget', async () => {
    const stub = stubFence(async () => execResult());
    const result = await runTool(
      {
        fence: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return stub.executor;
        },
      },
      { code: 'pass', timeoutMs: 50 }
    );
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'resolve_timed_out' });
    expect(stub.inputs).toHaveLength(0);
    expect(stub.dispose).toHaveBeenCalledTimes(1);
  });

  it('maps caller cancellation during construction to cancelled without running code', async () => {
    const controller = new AbortController();
    const reason = new Error('The caller stopped the run');
    const stub = stubFence(async () => execResult());
    const result = await runTool(
      {
        fence: async (signal) => {
          controller.abort(reason);
          signal?.throwIfAborted();
          return stub.executor;
        },
      },
      { code: 'pass' },
      { abortSignal: controller.signal }
    );
    expect(result).toEqual({
      kind: 'cancelled',
      partialStderr: '',
      partialStdout: '',
      processStarted: false,
      stderrOmittedBytes: 0,
      stdoutOmittedBytes: 0,
    });
    expect(stub.inputs).toHaveLength(0);
  });

  it('maps the shared construction deadline to resolve_timed_out without running code', async () => {
    const stub = stubFence(async () => execResult());
    const result = await runTool(
      {
        fence: async (signal) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          signal?.throwIfAborted();
          return stub.executor;
        },
      },
      { code: 'pass', timeoutMs: 50 }
    );
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'resolve_timed_out' });
    expect(stub.inputs).toHaveLength(0);
  });

  it('does not disguise an unrelated construction failure as cancellation', async () => {
    const controller = new AbortController();
    const failure = new Error('Unrelated construction failure');
    await expect(
      runTool(
        {
          fence: async () => {
            controller.abort(new Error('The caller stopped the run'));
            throw failure;
          },
        },
        { code: 'pass' },
        { abortSignal: controller.signal }
      )
    ).rejects.toBe(failure);
  });

  it.each([
    'sandbox_dependencies_missing',
    'sandbox_namespace_blocked',
    'sandbox_unsupported_runtime',
    'sandbox_readiness_timeout',
    'sandbox_readiness_failed',
  ] satisfies FenceReadinessReason[])(
    'reports %s construction failure distinctly from interpreter availability, without executing code',
    async (reason) => {
      const stub = stubFence(async () => execResult());
      const vm = vi.fn(() => stub.executor);
      const detail = 'The sandbox is unavailable. Check the platform sandbox prerequisites.';
      const failure = new FenceReadinessError(reason, detail);
      const mkdtemp = vi.spyOn(fsPromises, 'mkdtemp');
      try {
        const result = await runTool(
          { fence: () => Promise.reject(failure), vm },
          { code: 'print("must not run")' }
        );
        expect(result).toEqual({ detail, kind: 'unavailable', reason });
        expect(result).not.toMatchObject({ reason: 'interpreter_unavailable' });
        expect(result).not.toHaveProperty('exitCode');
        expect(mkdtemp).not.toHaveBeenCalled();
        expect(stub.inputs).toHaveLength(0);
        expect(vm).not.toHaveBeenCalled();
      } finally {
        mkdtemp.mockRestore();
      }
    }
  );
});
