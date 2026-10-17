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
  NoSandboxConfiguredError,
} from '../code-execution';
import {
  createRunPythonTool,
  projectRunPythonStreams,
  sliceTailCodePoints,
  toRunPythonResult,
} from '../tools/run-python-tool';
import { registerToolGuardDeadlineSignal } from '../tools/tool-guard-deadline';

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
  const tool = createRunPythonTool({
    resolveHost: resolveHostFor(host),
  });
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

  it('also aborts on the tool guard deadline, even though the run signal never fires (BST-1777)', async () => {
    const controller = new AbortController();
    const guard = new AbortController();
    const context = { abortSignal: controller.signal, toolCallId: 'run-python-call' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    let observedSignal: AbortSignal | undefined;
    const stub = stubFence((input) => {
      observedSignal = input.signal;
      // Settles only when the signal it was handed aborts, so the case can
      // await the run in its `finally` instead of leaving it pending forever.
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });
    const runPromise = runTool(hostWith(stub), { code: 'pass' }, context);
    try {
      // `vi.waitFor` rather than a fixed tick count: scratch-dir creation is
      // real fs I/O, and a loaded box that outran 50 macrotasks failed on
      // `undefined !== false` instead of saying the executor never started.
      await vi.waitFor(() => {
        expect(observedSignal).toBeDefined();
      });
      expect(observedSignal?.aborted).toBe(false);
      guard.abort(new Error('guard'));
      expect(observedSignal?.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      // Never leave a pending run (and its scratch dir) behind: the guard
      // abort above settles the stub, and the run is awaited before the case
      // ends. In a `finally` so a failed expectation cleans up too.
      release();
      await runPromise.catch(() => undefined);
    }
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

  it('maps a missing sandbox to no_sandbox_configured', async () => {
    const stub = stubFence(async () => {
      throw new NoSandboxConfiguredError();
    });
    const result = await runTool(hostWith(stub), { code: 'pass' });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'no_sandbox_configured' });
  });

  it('still returns the run result when disposing the executor fails', async () => {
    // A failing dispose is logged, not propagated: the script already ran and
    // its output is what the caller asked for. Swallowing the RESULT here
    // would turn a successful run into an error for a teardown problem.
    const inputs: ExecInput[] = [];
    const executor: CodeExecutor = {
      capabilities: () => FENCE_CAPABILITIES,
      dispose: async () => {
        throw new Error('sandbox manager refused to reset');
      },
      execute: (input: ExecInput) => {
        inputs.push(input);
        return Promise.resolve(execResult({ exitCode: 0, stdout: 'ok' }));
      },
    };
    const result = await runTool({ fence: () => executor }, { code: 'pass' });
    expect(result).toMatchObject({ exitCode: 0, kind: 'completed', stdout: 'ok' });
    expect(inputs).toHaveLength(1);
  });

  it('rethrows a non-Error throw rather than mistaking it for an interpreter failure', async () => {
    const tool = createRunPythonTool({
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately not an Error
      resolveHost: () => Promise.reject('a bare string, not an Error'),
    });
    await expect(tool.execute({ code: 'pass' })).rejects.toBe('a bare string, not an Error');
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
    const tool = createRunPythonTool({
      resolveHost: resolveHostFor(hostWith(stub)),
    });
    await expect(tool.execute({ allowedDomains: ['*'], code: 'pass' })).rejects.toThrow(
      'allowedDomains'
    );
    await expect(tool.execute({ code: 'pass', unknownField: true } as never)).rejects.toThrow(
      'invalid run_python input'
    );
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

  it("releases a small stderr's unused share back to a huge stdout", () => {
    // Both streams over budget, but stderr wants less than its 40% share:
    // the remainder belongs to stdout rather than being stranded.
    const hugeStdout = 'x'.repeat(50_000);
    const smallStderr = 'e'.repeat(500);
    const { stderr, stdout } = projectRunPythonStreams({
      stderr: smallStderr,
      stderrOmittedBytes: 0,
      stdout: hugeStdout,
      stdoutOmittedBytes: 0,
    });
    expect(stderr).toBe(smallStderr);
    // Well past the 60% share it would have received under a fixed split.
    expect(stdout.length).toBeGreaterThan(Math.floor(9800 * 0.6));
  });

  it("releases a small stdout's unused share back to a huge stderr", () => {
    // Mirror of the case above: a script that printed one line then blew up.
    // The traceback must NOT be handed the smaller half.
    const smallStdout = 'ok\n';
    const hugeStderr = 'T'.repeat(50_000);
    const { stderr, stdout } = projectRunPythonStreams({
      stderr: hugeStderr,
      stderrOmittedBytes: 0,
      stdout: smallStdout,
      stdoutOmittedBytes: 0,
    });
    expect(stdout).toBe(smallStdout);
    expect(stderr.length).toBeGreaterThan(Math.floor(9800 * 0.4));
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

describe('serialized-size fitting', () => {
  it('keeps escape-heavy output under the transport threshold once serialized', () => {
    // A script printing JSON is a routine run_python workload, and every
    // quote and backslash roughly doubles under JSON.stringify. Fitting on
    // raw length alone would let a "self-bounded" result still blow the
    // transport guard.
    const escapeHeavy = '"\\'.repeat(20_000);
    const projected = projectRunPythonStreams({
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: escapeHeavy,
      stdoutOmittedBytes: 0,
    });
    expect(JSON.stringify(projected.stdout).length).toBeLessThanOrEqual(9800);
    expect(projected.stdoutOmittedBytes).toBeGreaterThan(0);
  });

  it('does not tax plain ASCII output for escaping it never needs', () => {
    const plain = 'a'.repeat(9000);
    const projected = projectRunPythonStreams({
      stderr: '',
      stderrOmittedBytes: 0,
      stdout: plain,
      stdoutOmittedBytes: 0,
    });
    expect(projected.stdout).toBe(plain);
    expect(projected.stdoutOmittedBytes).toBe(0);
  });
});

describe('sliceTailCodePoints', () => {
  it('keeps the tail, which is where a traceback names the exception', () => {
    expect(sliceTailCodePoints('abcdef', 3)).toBe('def');
    expect(sliceTailCodePoints('abc', 10)).toBe('abc');
    expect(sliceTailCodePoints('abc', 0)).toBe('');
  });
});

describe('host-owned network consent', () => {
  function run(stub: StubExecutor, domains: string[] | undefined, resumeData?: unknown) {
    return createRunPythonTool({ resolveHost: resolveHostFor(hostWith(stub)) }).execute(
      { code: 'print(1)', ...(domains === undefined ? {} : { allowedDomains: domains }) },
      { resumeData }
    );
  }
  it('refuses nonempty domains before resolving an executor without host consent', async () => {
    const resolveHost = vi.fn(async () => hostWith(stubFence(async () => execResult())));
    const result = await createRunPythonTool({ resolveHost }).execute({
      allowedDomains: ['pypi.org'],
      code: 'pass',
    });
    expect(result).toMatchObject({
      kind: 'unavailable',
      reason: 'network_confirmation_unavailable',
    });
    expect(resolveHost).not.toHaveBeenCalled();
  });
  it('a denied consent never reaches the executor', async () => {
    const stub = stubFence(async () => execResult());
    expect(await run(stub, ['pypi.org'], { action: 'deny' })).toEqual({
      deniedDomains: ['pypi.org'],
      kind: 'network_denied',
    });
    expect(stub.inputs).toHaveLength(0);
  });
  it.each([
    { action: 'approved' },
    { action: 'allow', extra: true },
    'allow',
    { allow: true },
    null,
  ])('refuses drifted consent %j', async (resumeData) => {
    const stub = stubFence(async () => execResult());
    expect(await run(stub, ['pypi.org'], resumeData)).toMatchObject({
      kind: 'unavailable',
      reason: 'resume_unrecognized',
    });
    expect(stub.inputs).toHaveLength(0);
  });
  it('an allow consent grants only the deduplicated requested domains', async () => {
    const stub = stubFence(async () => execResult());
    expect(
      await run(stub, ['pypi.org', '*.example.com', 'pypi.org'], { action: 'allow' })
    ).toMatchObject({ kind: 'completed' });
    expect(stub.inputs).toHaveLength(1);
    expect(stub.inputs[0]?.policy.allowedDomains).toEqual(['pypi.org', '*.example.com']);
  });
  it.each([undefined, []])('no requested domains stay offline (%j)', async (domains) => {
    const stub = stubFence(async () => execResult());
    expect(await run(stub, domains, { action: 'allow' })).toMatchObject({ kind: 'completed' });
    expect(stub.inputs[0]?.policy.allowedDomains).toEqual([]);
  });
  it.each(['localhost', '127.0.0.1', '10.0.0.5', 'printer.local', '*.localhost'])(
    'refuses local network target %s',
    async (domain) => {
      const stub = stubFence(async () => execResult());
      await expect(run(stub, [domain], { action: 'allow' })).rejects.toThrow(
        'invalid run_python input'
      );
      expect(stub.inputs).toHaveLength(0);
    }
  );
});
