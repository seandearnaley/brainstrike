import fsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  type CodeExecutor,
  type CodeExecutorHostCapabilities,
  createNullCodeExecutor,
  ExecAbortedError,
  ExecCapabilityMismatchError,
  type ExecInput,
  type ExecResult,
  type ExecutorCapabilities,
} from '../code-execution';
import { createRunPythonTool, toRunPythonResult } from '../tools/run-python-tool';

const FENCE_CAPABILITIES: ExecutorCapabilities = {
  languages: ['python'],
  maxIsolationTier: 'os-fence',
  platform: 'darwin',
  supportsNetwork: true,
};

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

interface StubExecutor {
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly executor: CodeExecutor;
  readonly inputs: ExecInput[];
}

function stubFence(
  behaviour: (input: ExecInput) => Promise<ExecResult>,
  capabilities: ExecutorCapabilities = FENCE_CAPABILITIES
): StubExecutor {
  const inputs: ExecInput[] = [];
  const dispose = vi.fn(async () => undefined);
  const executor: CodeExecutor = {
    capabilities: () => capabilities,
    dispose,
    execute: (input: ExecInput) => {
      inputs.push(input);
      return behaviour(input);
    },
  };
  return { dispose, executor, inputs };
}

function hostWith(stub: StubExecutor): CodeExecutorHostCapabilities {
  return { fence: () => stub.executor };
}

async function runTool(
  host: CodeExecutorHostCapabilities,
  input: { code: string; timeoutMs?: number },
  context?: { abortSignal?: AbortSignal }
) {
  const tool = createRunPythonTool({ host });
  return await tool.execute(input, context);
}

describe('createRunPythonTool', () => {
  it('runs python through the seam and returns a completed result', async () => {
    const stub = stubFence(async () => execResult({ exitCode: 0, stdout: '45\n' }));
    const result = await runTool(hostWith(stub), { code: 'print(sum(range(10)))' });
    expect(result).toEqual({
      exitCode: 0,
      kind: 'completed',
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: '45\n',
      stdoutOmittedBytes: 0,
    });
  });

  it('gives the script NO network and only a scratch dir to write, and cleans it up', async () => {
    const stub = stubFence(async () => execResult());
    await runTool(hostWith(stub), { code: 'pass' });
    const input = stub.inputs[0];
    if (!input) {
      throw new Error('executor was never called');
    }
    // The security core of this tool: egress is not merely defaulted off, it
    // is unreachable from the input schema.
    expect(input.policy.allowedDomains).toEqual([]);
    expect(input.policy.allowWrite).toEqual([input.scratchDir]);
    expect(input.language).toBe('python');
    // Scratch dir must not outlive the call.
    await expect(fsPromises.access(input.scratchDir)).rejects.toThrow();
  });

  it('removes the scratch dir even when the executor throws', async () => {
    const stub = stubFence(async () => {
      throw new ExecCapabilityMismatchError('network_unsupported', 'no network here');
    });
    const result = await runTool(hostWith(stub), { code: 'pass' });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'network_unsupported' });
    const scratchDir = stub.inputs[0]?.scratchDir;
    expect(scratchDir).toBeDefined();
    await expect(fsPromises.access(scratchDir as string)).rejects.toThrow();
  });

  it('disposes the executor it resolved, on both the success and failure paths', async () => {
    const ok = stubFence(async () => execResult());
    await runTool(hostWith(ok), { code: 'pass' });
    expect(ok.dispose).toHaveBeenCalledTimes(1);

    const bad = stubFence(async () => {
      throw new ExecCapabilityMismatchError('language_unsupported', 'nope');
    });
    await runTool(hostWith(bad), { code: 'pass' });
    expect(bad.dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards the caller abort signal so Stop can kill the process tree', async () => {
    const controller = new AbortController();
    const stub = stubFence(async () => execResult());
    await runTool(hostWith(stub), { code: 'pass' }, { abortSignal: controller.signal });
    expect(stub.inputs[0]?.signal).toBe(controller.signal);
  });

  it('passes the requested timeout through and defaults to 30s', async () => {
    const stub = stubFence(async () => execResult());
    await runTool(hostWith(stub), { code: 'pass', timeoutMs: 1234 });
    expect(stub.inputs[0]?.timeoutMs).toBe(1234);

    const defaulted = stubFence(async () => execResult());
    await runTool(hostWith(defaulted), { code: 'pass' });
    expect(defaulted.inputs[0]?.timeoutMs).toBe(30_000);
  });

  it('reports cancellation as cancelled with partial output, never as success', async () => {
    const stub = stubFence(async () => {
      throw new ExecAbortedError({
        partialStderr: 'warn',
        partialStdout: 'half',
        processStarted: true,
      });
    });
    const result = await runTool(hostWith(stub), { code: 'pass' });
    expect(result).toEqual({
      kind: 'cancelled',
      partialStderr: 'warn',
      partialStdout: 'half',
    });
  });

  it('returns unavailable (not a crash) when the host has no fence', async () => {
    const result = await runTool({}, { code: 'pass' });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'executor_kind_unavailable' });
  });

  it('returns unavailable when the only executor is the null stub', async () => {
    // The null stub reports tier 'none', so the seam refuses it as a fence
    // rather than letting unisolated execution through.
    const result = await runTool(
      { fence: () => createNullCodeExecutor({ platform: 'darwin' }) },
      { code: 'pass' }
    );
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'executor_tier_mismatch' });
  });

  it('rethrows an unrecognised failure instead of labelling it unavailable', async () => {
    const stub = stubFence(async () => {
      throw new Error('something nobody has classified');
    });
    await expect(runTool(hostWith(stub), { code: 'pass' })).rejects.toThrow(
      'something nobody has classified'
    );
  });

  it('rejects input the strict schema does not accept, without reaching the executor', async () => {
    const stub = stubFence(async () => execResult());
    const tool = createRunPythonTool({ host: hostWith(stub) });
    // Mastra validates against inputSchema BEFORE execute() runs and returns a
    // validation-error payload rather than throwing — so this asserts the
    // returned shape, not a rejection.
    const withUnknownKey = await tool.execute({
      allowedDomains: ['evil.example.com'],
      code: 'pass',
    } as never);
    expect(withUnknownKey).toMatchObject({ error: true });
    expect(JSON.stringify(withUnknownKey)).toContain('allowedDomains');

    const withEmptyCode = await tool.execute({ code: '' });
    expect(withEmptyCode).toMatchObject({ error: true });

    // The load-bearing half: neither malformed call reached the sandbox.
    expect(stub.inputs).toHaveLength(0);
  });
});

describe('toRunPythonResult', () => {
  it('maps a signal kill with timedOut false to killed, not completed', () => {
    const result = toRunPythonResult(
      execResult({ exitCode: null, signal: 'SIGSEGV', stdout: 'partial' }),
      30_000
    );
    expect(result).toMatchObject({ kind: 'killed', signal: 'SIGSEGV' });
    expect(result).not.toHaveProperty('exitCode');
  });

  it('maps a timeout kill to timed_out carrying the budget it exceeded', () => {
    const result = toRunPythonResult(
      execResult({ exitCode: null, signal: 'SIGKILL', timedOut: true }),
      5000
    );
    expect(result).toMatchObject({ kind: 'timed_out', signal: 'SIGKILL', timeoutMs: 5000 });
  });

  it('keeps a non-zero exit code as completed — the tool worked, the script failed', () => {
    const result = toRunPythonResult(execResult({ exitCode: 1, stderr: 'Traceback' }), 30_000);
    expect(result).toMatchObject({ exitCode: 1, kind: 'completed', stderr: 'Traceback' });
  });

  it('adds its own trimming to the executor omitted-byte counts', () => {
    const huge = 'x'.repeat(200_000);
    const result = toRunPythonResult(
      execResult({ exitCode: 0, stdout: huge, stdoutOmittedBytes: 500 }),
      30_000
    );
    if (result.kind !== 'completed') {
      throw new Error(`expected completed, got ${result.kind}`);
    }
    expect(result.stdout.length).toBeLessThan(huge.length);
    // 500 dropped by the executor PLUS everything this projection trimmed —
    // reporting only one layer would understate the loss.
    expect(result.stdoutOmittedBytes).toBe(500 + (huge.length - result.stdout.length));
    // The tail is what survives: a traceback ends with the exception.
    expect(huge.endsWith(result.stdout)).toBe(true);
  });
});
