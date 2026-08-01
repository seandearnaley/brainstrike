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
import {
  createRunPythonTool,
  projectRunPythonStreams,
  sliceTailCodePoints,
  toRunPythonResult,
} from '../tools/run-python-tool';

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

function resolveHostFor(host: CodeExecutorHostCapabilities) {
  return async () => host;
}

async function runTool(
  host: CodeExecutorHostCapabilities,
  input: { code: string; timeoutMs?: number },
  context?: { abortSignal?: AbortSignal }
) {
  const tool = createRunPythonTool({ resolveHost: resolveHostFor(host) });
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

  it('spends ONE budget across host resolution and execution', async () => {
    // Not two independent budgets: resolving can be slow on a cold first run
    // (hashing + unpacking the bundled CPython), and giving execute a fresh
    // full timeout afterwards would let a call the model capped at 30s run
    // far longer. execute() therefore receives the REMAINING time.
    const stub = stubFence(async () => execResult());
    await runTool(hostWith(stub), { code: 'pass', timeoutMs: 1234 });
    const spent = stub.inputs[0]?.timeoutMs ?? 0;
    expect(spent).toBeLessThanOrEqual(1234);
    expect(spent).toBeGreaterThan(1000);

    const defaulted = stubFence(async () => execResult());
    await runTool(hostWith(defaulted), { code: 'pass' });
    expect(defaulted.inputs[0]?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(defaulted.inputs[0]?.timeoutMs).toBeGreaterThan(29_000);
  });

  it('refuses to run when resolving the host consumed the whole budget', async () => {
    const stub = stubFence(async () => execResult());
    const tool = createRunPythonTool({
      resolveHost: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return hostWith(stub);
      },
    });
    const result = await tool.execute({ code: 'pass', timeoutMs: 50 });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'resolve_timed_out' });
    // Never spawned with a zero/negative budget.
    expect(stub.inputs).toHaveLength(0);
  });

  it('reports cancellation as cancelled with partial output, never as success', async () => {
    const stub = stubFence(async () => {
      throw new ExecAbortedError({
        partialStderr: 'warn',
        partialStdout: 'half',
        processStarted: true,
        stderrOmittedBytes: 7,
        stdoutOmittedBytes: 11,
      });
    });
    const result = await runTool(hostWith(stub), { code: 'pass' });
    expect(result).toEqual({
      kind: 'cancelled',
      partialStderr: 'warn',
      partialStdout: 'half',
      processStarted: true,
      stderrOmittedBytes: 7,
      stdoutOmittedBytes: 11,
    });
  });

  it('bounds cancelled partial output through the same projection as every other arm', async () => {
    // The fence bounds partials only by maxOutputBytes (megabytes), so
    // returning them verbatim would trip the transport guard and the user
    // pressing Stop would lose the partial output entirely — the exact
    // outcome this arm exists to prevent.
    const huge = 'y'.repeat(500_000);
    const stub = stubFence(async () => {
      throw new ExecAbortedError({ partialStdout: huge, processStarted: true });
    });
    const result = await runTool(hostWith(stub), { code: 'pass' });
    if (result.kind !== 'cancelled') {
      throw new Error(`expected cancelled, got ${result.kind}`);
    }
    expect(result.partialStdout.length).toBeLessThan(huge.length);
    expect(result.stdoutOmittedBytes).toBe(huge.length - result.partialStdout.length);
  });

  it('distinguishes an abort that never spawned from one killed mid-run', async () => {
    const stub = stubFence(async () => {
      throw new ExecAbortedError({ processStarted: false });
    });
    const result = await runTool(hostWith(stub), { code: 'pass' });
    expect(result).toMatchObject({ kind: 'cancelled', processStarted: false });
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

  it('distinguishes a missing interpreter from a missing sandbox', async () => {
    // BST-1061 carried this requirement into BST-1067: the user must be told
    // WHICH half is missing. A generic failure here would collapse "no Python
    // was bundled for this platform" into "no sandbox", which points at the
    // wrong fix.
    const interpreterFailure = Object.assign(
      new Error('The bundled Python runtime does not support linux/x64'),
      { code: 'python_unsupported_platform' }
    );
    const tool = createRunPythonTool({
      resolveHost: () => Promise.reject(interpreterFailure),
    });
    const result = await tool.execute({ code: 'pass' });
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'interpreter_unavailable',
    });
    expect(result).not.toMatchObject({ reason: 'no_sandbox_configured' });
  });

  it('disposes the executor even when scratch-dir creation fails', async () => {
    // The leak this guards is PROCESS-GLOBAL, not per-call: createFenceExecutor
    // increments a module-level session count that only dispose() decrements,
    // and only reaching zero resets the srt sandbox manager. One escape pins
    // it for the lifetime of the desktop main process.
    const stub = stubFence(async () => execResult());
    const mkdtemp = vi
      .spyOn(fsPromises, 'mkdtemp')
      .mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );
    try {
      await expect(runTool(hostWith(stub), { code: 'pass' })).rejects.toThrow(/ENOSPC/);
    } finally {
      mkdtemp.mockRestore();
    }
    expect(stub.dispose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a scratch-cleanup failure instead of silently claiming success', async () => {
    // Sandboxed code can chmod(0) a nested dir. Returning a clean success then
    // would contradict the tool's own guarantee that nothing it writes
    // persists.
    const stub = stubFence(async () => execResult({ exitCode: 0, stdout: 'done' }));
    const rm = vi
      .spyOn(fsPromises, 'rm')
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    try {
      const result = await runTool(hostWith(stub), { code: 'pass' });
      expect(result).toMatchObject({
        exitCode: 0,
        kind: 'completed',
        scratchCleanupFailed: true,
      });
      expect((result as { scratchDir?: string }).scratchDir).toBeDefined();
    } finally {
      rm.mockRestore();
    }
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
    const tool = createRunPythonTool({ resolveHost: resolveHostFor(hostWith(stub)) });
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

describe('projectRunPythonStreams', () => {
  it('never splits a surrogate pair at the tail boundary', () => {
    // A lone surrogate is not encodable as UTF-8 and breaks JSON
    // serialization on the way to the provider. run_python is pitched at data
    // wrangling, so astral output is routine.
    const emoji = '😀'.repeat(20_000);
    const { stdout } = projectRunPythonStreams({
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: emoji,
      stdoutOmittedBytes: 0,
    });
    expect(stdout.length).toBeLessThan(emoji.length);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(stdout)
    ).toBe(false);
    expect(Buffer.from(stdout, 'utf8').toString('utf8')).toBe(stdout);
  });

  it('counts omitted output in UTF-8 bytes, matching what the executor counts', () => {
    const emoji = '😀'.repeat(20_000);
    const { stdout, stdoutOmittedBytes } = projectRunPythonStreams({
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: emoji,
      stdoutOmittedBytes: 0,
    });
    // Each 😀 is 4 UTF-8 bytes but 2 UTF-16 code units; a code-unit count
    // would understate the loss by ~2x.
    expect(stdoutOmittedBytes).toBe(
      Buffer.byteLength(emoji, 'utf8') - Buffer.byteLength(stdout, 'utf8')
    );
    expect(stdoutOmittedBytes).toBeGreaterThan(emoji.length - stdout.length);
  });

  it('does not let one newline on stderr evict most of stdout', () => {
    // The presence-based split gave stdout only 60% the moment stderr was
    // non-empty — and Python emits stray newlines constantly.
    const stdout = 'a'.repeat(9000);
    const withoutStderr = projectRunPythonStreams({
      stderr: '',
      stderrOmittedBytes: 0,
      stdout,
      stdoutOmittedBytes: 0,
    });
    const withStderr = projectRunPythonStreams({
      stderr: '\n',
      stderrOmittedBytes: 0,
      stdout,
      stdoutOmittedBytes: 0,
    });
    expect(withoutStderr.stdout).toBe(stdout);
    expect(withStderr.stdout).toBe(stdout);
    expect(withStderr.stdoutOmittedBytes).toBe(0);
  });

  it('splits only a genuinely contested budget', () => {
    const big = 'x'.repeat(50_000);
    const { stderr, stdout } = projectRunPythonStreams({
      stderr: big,
      stderrOmittedBytes: 0,
      stdout: big,
      stdoutOmittedBytes: 0,
    });
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout.length + stderr.length).toBeLessThanOrEqual(9800);
  });
});

describe('sliceTailCodePoints', () => {
  it('keeps the tail, which is where a traceback names the exception', () => {
    expect(sliceTailCodePoints('abcdef', 3)).toBe('def');
    expect(sliceTailCodePoints('abc', 10)).toBe('abc');
    expect(sliceTailCodePoints('abc', 0)).toBe('');
  });
});
