import type { GuardedToolError } from '@brainstrike/assistant-contract';
import {
  BoundaryFailureError,
  INTERNAL_FAULT,
  refusal,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  applyToolGuards,
  formatToolInactivityMessage,
  formatToolTimeoutMessage,
  formatToolTotalBudgetMessage,
  guardToolExecution,
  isGuardedToolError,
} from '../tools/guard-tool-execution';
import {
  readToolGuardDeadlineSignal,
  readToolGuardRemainingMs,
  reportToolGuardActivity,
  resolveGuardedToolSignal,
  toolGuardOwnsInactivity,
} from '../tools/tool-guard-deadline';

function makeTool(execute: (...args: unknown[]) => unknown) {
  return { description: 'd', execute, id: 'demo' };
}

describe('guardToolExecution', () => {
  it('keeps a retained local cause out of the trusted input result', async () => {
    const cause = new Error('PRIVATE credential and filesystem detail');
    const error = new ToolInputError('Choose an existing file.', { cause });
    const tool = guardToolExecution(
      makeTool(() => {
        throw error;
      }),
      {
        timeoutMs: 1000,
        toolName: 'demo',
      }
    );
    expect(error.cause).toBe(cause);
    const result = await tool.execute({ context: {} });
    expect(result).toEqual({
      error: { code: 'tool_input_invalid', message: 'Choose an existing file.', toolName: 'demo' },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|cause|stack/);
  });

  it('passes through a successful result unchanged', async () => {
    const tool = guardToolExecution(
      makeTool(async () => ({ value: 42 })),
      {
        timeoutMs: 1000,
        toolName: 'demo',
      }
    );
    await expect(tool.execute({ context: {} })).resolves.toEqual({ value: 42 });
  });

  it('returns a structured timeout error when execute never resolves', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      { timeoutMs: 50, toolName: 'demo' }
    );
    const promise = tool.execute({ context: {} });
    await vi.advanceTimersByTimeAsync(60);
    const result = (await promise) as GuardedToolError;
    expect(isGuardedToolError(result)).toBe(true);
    expect(result.error.code).toBe('tool_timeout');
    expect(result.error.toolName).toBe('demo');
    vi.useRealTimers();
  });

  it('returns a structured failure error when execute throws, without leaking raw message', async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const tool = guardToolExecution(
      makeTool(() => {
        throw new Error('SECRET internal path /Users/x/.ssh');
      }),
      { logger, timeoutMs: 1000, toolName: 'demo' }
    );
    const result = (await tool.execute({ context: {} })) as GuardedToolError;
    expect(result.error.code).toBe('tool_failed');
    expect(result.error.message).not.toContain('SECRET');
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs a failing tool once, with no late-rejection line when no timeout fired', async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const tool = guardToolExecution(
      makeTool(() => {
        throw new Error('disk full');
      }),
      { logger, timeoutMs: 1000, toolName: 'demo' }
    );
    await tool.execute({ context: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.error.mock.calls.map(([message]) => message)).toEqual(['Tool execution failed']);
  });

  it("never counts the model's refused input as an app error", async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const refusing = [
      new ToolInputError('"3a08d2e9" is not one of this thread\'s folders: beaker.'),
      new BoundaryFailureError(
        refusal({
          category: 'conflict',
          code: 'workspace.folder-removed',
          message: 'The folder "bravo" was removed from the workspace.',
          remedy: 'Re-add the folder to continue.',
        })
      ),
    ];
    for (const error of refusing) {
      const tool = guardToolExecution(
        makeTool(() => {
          throw error;
        }),
        { logger, timeoutMs: 1000, toolName: 'brainstrike.readWorkspaceFile' }
      );
      const result = (await tool.execute({ context: {} })) as GuardedToolError;
      expect(result.error.code).toBe('tool_input_invalid');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });

  it('returns a correctable input error without hiding its trusted model-facing message', async () => {
    const tool = guardToolExecution(
      makeTool(() => {
        throw new ToolInputError(
          'Multiple folders are open. Specify "root". Open folders: ProjectA, ProjectB.'
        );
      }),
      { timeoutMs: 1000, toolName: 'brainstrike.lspInspect' }
    );

    await expect(tool.execute({ context: {} })).resolves.toEqual({
      error: {
        code: 'tool_input_invalid',
        message: 'Multiple folders are open. Specify "root". Open folders: ProjectA, ProjectB.',
        toolName: 'brainstrike.lspInspect',
      },
      ok: false,
    });
  });

  it('returns a typed refusal from another process as its model-facing message', async () => {
    const tool = guardToolExecution(
      makeTool(() => {
        throw new BoundaryFailureError(
          refusal({
            category: 'conflict',
            code: 'workspace.folder-removed',
            message: 'The folder "bravo" was removed from the workspace.',
            remedy: 'Re-add the folder to continue.',
          })
        );
      }),
      { timeoutMs: 1000, toolName: 'brainstrike.readFile' }
    );

    await expect(tool.execute({ context: {} })).resolves.toEqual({
      error: {
        code: 'tool_input_invalid',
        message:
          'The folder "bravo" was removed from the workspace. Re-add the folder to continue.',
        toolName: 'brainstrike.readFile',
      },
      ok: false,
    });
  });

  it('keeps a typed fault from another process behind the fixed failure text', async () => {
    const tool = guardToolExecution(
      makeTool(() => {
        throw new BoundaryFailureError(INTERNAL_FAULT);
      }),
      { timeoutMs: 1000, toolName: 'brainstrike.readFile' }
    );

    const result = (await tool.execute({ context: {} })) as GuardedToolError;
    expect(result.error.code).toBe('tool_failed');
    expect(result.error.message).not.toBe(INTERNAL_FAULT.message);
  });

  it('bounds an oversized correctable input error before returning it to the model', async () => {
    const tool = guardToolExecution(
      makeTool(() => {
        throw new ToolInputError(`Stale match. Current line: ${'x'.repeat(2_000_000)}`);
      }),
      { timeoutMs: 1000, toolName: 'brainstrike.lspInspect' }
    );

    const result = (await tool.execute({ context: {} })) as GuardedToolError;
    expect(result.error.code).toBe('tool_input_invalid');
    expect(result.error.message.length).toBeLessThanOrEqual(1000);
    expect(result.error.message).toMatch(/\u2026 \[input error truncated\]$/);
  });

  it('aborts the deadline the running tool can observe before reporting the timeout', async () => {
    vi.useFakeTimers();
    const context = { toolCallId: 'call-1' };
    let observed: AbortSignal | undefined;
    const tool = guardToolExecution(
      makeTool((...args: unknown[]) => {
        observed = readToolGuardDeadlineSignal(args[1]);
        return new Promise(() => {});
      }),
      { timeoutMs: 50, toolName: 'demo' }
    );

    const promise = tool.execute({}, context);
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    const result = (await promise) as GuardedToolError;
    expect(result.error.code).toBe('tool_timeout');
    expect(observed?.aborted).toBe(true);
    expect(String((observed as AbortSignal).reason)).toContain('demo');
    vi.useRealTimers();
  });

  it('leaves the deadline unaborted when the tool settles inside its budget', async () => {
    const context = { toolCallId: 'call-2' };
    let observed: AbortSignal | undefined;
    const tool = guardToolExecution(
      makeTool(async (...args: unknown[]) => {
        observed = readToolGuardDeadlineSignal(args[1]);
        return { value: 1 };
      }),
      { timeoutMs: 1000, toolName: 'demo' }
    );

    await expect(tool.execute({}, context)).resolves.toEqual({ value: 1 });
    expect(observed?.aborted).toBe(false);
  });

  it.each([false, true])(
    'owns each invocation when provider IDs repeat (reused context: %s)',
    async (reuseContext) => {
      vi.useFakeTimers();
      const lookup = Promise.withResolvers<void>();
      const readyA = Promise.withResolvers<void>();
      const readyB = Promise.withResolvers<void>();
      const finishA = Promise.withResolvers<void>();
      const finishB = Promise.withResolvers<void>();
      const joinedA = Promise.withResolvers<void>();
      const caller = new AbortController();
      const contextA = Object.freeze({
        _meta: { source: 'host' },
        abortSignal: caller.signal,
        resumeData: { approved: true },
        runId: 'run',
        threadId: 'thread',
        toolCallId: 'call_1',
        writer: { custom: async () => undefined },
      });
      const contextB = reuseContext ? contextA : { ...contextA };
      let observedA: unknown;
      let observedB: unknown;
      let signalA: AbortSignal | undefined;
      let signalB: AbortSignal | undefined;
      const first = guardToolExecution(
        makeTool(async (_input, context) => {
          observedA = context;
          await lookup.promise;
          signalA = resolveGuardedToolSignal(context);
          readyA.resolve();
          await finishA.promise;
          joinedA.resolve();
          return 'first';
        }),
        { timeoutMs: 50, toolName: 'first' }
      );
      const second = guardToolExecution(
        makeTool(async (_input, context) => {
          observedB = context;
          await lookup.promise;
          signalB = resolveGuardedToolSignal(context);
          readyB.resolve();
          await finishB.promise;
          return 'second';
        }),
        { timeoutMs: 5000, toolName: 'second' }
      );
      const firstCall = first.execute({}, contextA);
      const secondCall = second.execute({}, contextB);
      try {
        lookup.resolve();
        await Promise.all([readyA.promise, readyB.promise]);
        expect(observedA).toEqual(contextA);
        expect(observedB).toEqual(contextB);
        expect(observedA).not.toBe(observedB);
        for (const context of [observedA, observedB]) {
          if (typeof context !== 'object' || context === null) {
            throw new Error('Missing forwarded execution context');
          }
          expect(Reflect.get(context, 'abortSignal')).toBe(caller.signal);
          expect(Reflect.get(context, 'writer')).toBe(contextA.writer);
          expect(Reflect.get(context, '_meta')).toBe(contextA._meta);
          expect(Reflect.get(context, 'resumeData')).toBe(contextA.resumeData);
        }
        await vi.advanceTimersByTimeAsync(50);
        await expect(firstCall).resolves.toMatchObject({
          error: { code: 'tool_timeout' },
          ok: false,
        });
        expect(signalA?.aborted).toBe(true);
        expect(signalB?.aborted).toBe(false);
        expect(caller.signal.aborted).toBe(false);
        expect(readToolGuardDeadlineSignal(observedA)).toBeUndefined();
        expect(readToolGuardDeadlineSignal(observedB)).toBeInstanceOf(AbortSignal);
        finishA.resolve();
        await joinedA.promise;
        expect(readToolGuardDeadlineSignal(observedB)).toBeInstanceOf(AbortSignal);
        finishB.resolve();
        await expect(secondCall).resolves.toBe('second');
        expect(readToolGuardDeadlineSignal(observedB)).toBeUndefined();
        expect(signalB?.aborted).toBe(false);
      } finally {
        lookup.resolve();
        finishA.resolve();
        finishB.resolve();
        await Promise.all([firstCall, secondCall]);
        vi.useRealTimers();
      }
    }
  );

  it('leaves a tool without an execute function untouched', () => {
    const noExec = { description: 'd', id: 'x' } as { id: string; description: string };
    expect(guardToolExecution(noExec, { timeoutMs: 1000, toolName: 'x' })).toBe(noExec);
  });

  it('logs a late rejection after a timeout instead of dropping it', async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), error: vi.fn() };
    let rejectRun: ((reason: unknown) => void) | undefined;
    const tool = guardToolExecution(
      makeTool(
        () =>
          new Promise((_resolve, reject) => {
            rejectRun = reject;
          })
      ),
      { logger, timeoutMs: 50, toolName: 'demo' }
    );
    const promise = tool.execute({ context: {} });
    await vi.advanceTimersByTimeAsync(60);
    const result = (await promise) as GuardedToolError;
    expect(result.error.code).toBe('tool_timeout');
    rejectRun?.(new Error('late boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('resolves the timeout per call from the call args', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      {
        timeoutMs: (args) => (args[0] as { timeoutMs: number }).timeoutMs,
        toolName: 'demo',
      }
    );
    const short = tool.execute({ timeoutMs: 50 });
    const long = tool.execute({ timeoutMs: 5000 });
    let longSettled = false;
    void Promise.resolve(long).then(() => {
      longSettled = true;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(((await short) as GuardedToolError).error.code).toBe('tool_timeout');
    expect(longSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(((await long) as GuardedToolError).error.code).toBe('tool_timeout');
    vi.useRealTimers();
  });

  it('reports the GRANTED budget (margin invisible) and the remedy when a longer one could be asked for', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      {
        declaredMaxMs: 600_000,
        // executeCommand's default call: 120s granted, 125s guard window.
        timeoutMs: () => ({ grantedMs: 120_000, guardMs: 125_000 }),
        toolName: 'demo',
      }
    );
    const promise = tool.execute({});
    await vi.advanceTimersByTimeAsync(125_000);
    const { error } = (await promise) as GuardedToolError;
    expect(error.message).toBe(
      'The tool did not finish within its 120s execution budget and was cancelled. Pass a larger timeoutMs (up to 600000 ms) if the work legitimately needs longer, or split it into smaller steps.'
    );
    vi.useRealTimers();
  });

  it('reports an explicitly requested budget below the max and still offers the remedy', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      {
        declaredMaxMs: 600_000,
        timeoutMs: () => ({ grantedMs: 300_000, guardMs: 305_000 }),
        toolName: 'demo',
      }
    );
    const promise = tool.execute({});
    await vi.advanceTimersByTimeAsync(305_000);
    const { error } = (await promise) as GuardedToolError;
    expect(error.message).toBe(
      'The tool did not finish within its 300s execution budget and was cancelled. Pass a larger timeoutMs (up to 600000 ms) if the work legitimately needs longer, or split it into smaller steps.'
    );
    vi.useRealTimers();
  });

  it('never advises a larger timeoutMs when the call already had the declared max', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      {
        declaredMaxMs: 600_000,
        timeoutMs: () => ({ grantedMs: 600_000, guardMs: 605_000 }),
        toolName: 'demo',
      }
    );
    const promise = tool.execute({});
    await vi.advanceTimersByTimeAsync(605_000);
    const { error } = (await promise) as GuardedToolError;
    expect(error.message).toBe(
      'The tool did not finish within its 600s execution budget and was cancelled. That is the largest budget this tool allows, so split the work into smaller steps.'
    );
    expect(error.message).not.toContain('larger timeoutMs');
    vi.useRealTimers();
  });

  it('does not suggest timeoutMs for a tool that has none', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      { timeoutMs: 60_000, toolName: 'demo' }
    );
    const promise = tool.execute({});
    await vi.advanceTimersByTimeAsync(60_000);
    const { error } = (await promise) as GuardedToolError;
    expect(error.message).toBe(
      'The tool did not finish within its 60s execution budget and was cancelled. Try a smaller request or another approach.'
    );
    vi.useRealTimers();
  });

  it('a resolver that returns a non-positive budget fails the call loudly instead of arming a 0ms timer', async () => {
    const tool = guardToolExecution(
      makeTool(async () => 'ok'),
      { timeoutMs: () => 0, toolName: 'demo' }
    );
    const result = (await tool.execute({})) as GuardedToolError;
    expect(result.error.code).toBe('tool_failed');
  });
});

describe('formatToolTimeoutMessage', () => {
  it('never reports a 0s budget for a sub-1000ms grant (round 2, Claude D)', () => {
    expect(formatToolTimeoutMessage(300, 600_000)).toBe(
      'The tool did not finish within its 300 ms execution budget and was cancelled. Pass a larger timeoutMs (up to 600000 ms) if the work legitimately needs longer, or split it into smaller steps.'
    );
  });

  it('still reports whole seconds at or above 1000ms', () => {
    expect(formatToolTimeoutMessage(1000, undefined)).toBe(
      'The tool did not finish within its 1s execution budget and was cancelled. Try a smaller request or another approach.'
    );
  });

  // Rounding MISSTATES the grant: 1500ms read "2s" and 1499ms read "1s", and a
  // model sizes its next `timeoutMs` from this number (PR review).
  it.each([
    [1499, '1499 ms'],
    [1500, '1500 ms'],
    [90_500, '90500 ms'],
    [120_000, '120s'],
  ])('reports a %dms grant exactly, as "%s"', (grantedMs, rendered) => {
    expect(formatToolTimeoutMessage(grantedMs, undefined)).toBe(
      `The tool did not finish within its ${rendered} execution budget and was cancelled. Try a smaller request or another approach.`
    );
  });
});

describe('applyToolGuards', () => {
  it('guards every executable tool in the map', async () => {
    vi.useFakeTimers();
    const tools = {
      a: { description: 'd', execute: (..._args: unknown[]) => new Promise(() => {}), id: 'a' },
      b: { description: 'd', execute: async (..._args: unknown[]) => ({ ok: true }), id: 'b' },
    };
    const guarded = applyToolGuards(tools, { timeoutMs: 20 });
    const aPromise = guarded.a.execute({ context: {} });
    await vi.advanceTimersByTimeAsync(30);
    const aResult = await aPromise;
    expect(isGuardedToolError(aResult)).toBe(true);
    vi.useRealTimers();
    await expect(guarded.b.execute({ context: {} })).resolves.toEqual({ ok: true });
  });

  it('resolves a per-tool timeout when given a function of the tool id', async () => {
    vi.useFakeTimers();
    const guarded = applyToolGuards(
      { fast: makeTool(() => new Promise(() => {})), slow: makeTool(() => new Promise(() => {})) },
      { timeoutMs: (toolId) => (toolId === 'fast' ? 10 : 1000) }
    );
    const fast = guarded.fast.execute({});
    const slow = guarded.slow.execute({});
    let slowSettled = false;
    void Promise.resolve(slow).then(() => {
      slowSettled = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(((await fast) as GuardedToolError).error.code).toBe('tool_timeout');
    expect(slowSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await slow;
    vi.useRealTimers();
  });
});

describe('guardToolExecution inactivity budget (BST-1779)', () => {
  const FAKE = {
    toFake: ['setTimeout', 'clearTimeout', 'performance'] as (
      | 'setTimeout'
      | 'clearTimeout'
      | 'performance'
    )[],
  };
  /** A call that never settles, exposing the context the guard forwarded. */
  function hangingTool() {
    const seen: { context?: unknown } = {};
    const tool = makeTool((_input: unknown, context: unknown) => {
      seen.context = context;
      return new Promise(() => {});
    });
    return { seen, tool };
  }

  it('restarts its window on each activity, then ends at the total budget, cancelling the work', async () => {
    vi.useFakeTimers(FAKE);
    try {
      const { seen, tool } = hangingTool();
      const guarded = guardToolExecution(tool, {
        activity: { maxTotalMs: 1000 },
        timeoutMs: 300,
        toolName: 'demo',
      });
      let settled: unknown;
      const result = Promise.resolve(guarded.execute({}, { toolCallId: 'call-1' })).then(
        (value: unknown) => {
          settled = value;
          return value;
        }
      );
      for (let step = 0; step < 4; step += 1) {
        await vi.advanceTimersByTimeAsync(200);
        reportToolGuardActivity(seen.context);
      }
      // 800 ms in, no window ever went 300 ms silent: still running.
      expect(settled).toBeUndefined();
      expect(toolGuardOwnsInactivity(seen.context)).toBe(true);
      const deadline = readToolGuardDeadlineSignal(seen.context);
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toEqual({
        error: {
          code: 'tool_timeout',
          message: formatToolTotalBudgetMessage(1000),
          toolName: 'demo',
        },
        ok: false,
      });
      expect(deadline?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a silent call at its window, naming the silence and the total it could have had', async () => {
    vi.useFakeTimers(FAKE);
    try {
      const guarded = guardToolExecution(hangingTool().tool, {
        activity: { maxTotalMs: 600_000 },
        timeoutMs: 60_000,
        toolName: 'demo',
      });
      const result = guarded.execute({}, { toolCallId: 'call-1' });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(result).resolves.toMatchObject({
        error: { message: formatToolInactivityMessage(60_000, 600_000) },
      });
      expect(formatToolInactivityMessage(60_000, 600_000)).toBe(
        'The tool reported no progress for 60s and was cancelled (it may run up to 600s while it reports progress). Try a smaller request or another approach.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a silent call ended by a total shorter than its window is told it was silent, not chatty', async () => {
    vi.useFakeTimers(FAKE);
    try {
      const guarded = guardToolExecution(hangingTool().tool, {
        activity: { maxTotalMs: 600 },
        timeoutMs: 900,
        toolName: 'demo',
      });
      const result = guarded.execute({}, { toolCallId: 'call-1' });
      await vi.advanceTimersByTimeAsync(600);
      await expect(result).resolves.toMatchObject({
        error: { code: 'tool_timeout', message: formatToolInactivityMessage(600, 600) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the running tool how long it has left, counting from its latest activity', async () => {
    vi.useFakeTimers(FAKE);
    try {
      const { seen, tool } = hangingTool();
      const guarded = guardToolExecution(tool, {
        activity: { maxTotalMs: 1000 },
        timeoutMs: 300,
        toolName: 'demo',
      });
      void guarded.execute({}, { toolCallId: 'call-1' });
      await vi.advanceTimersByTimeAsync(200);
      expect(readToolGuardRemainingMs(seen.context)).toBe(100);
      reportToolGuardActivity(seen.context);
      expect(readToolGuardRemainingMs(seen.context)).toBe(300);
      // The last window is cut to what the total leaves: 1000 - 900 = 100.
      await vi.advanceTimersByTimeAsync(250);
      reportToolGuardActivity(seen.context);
      await vi.advanceTimersByTimeAsync(250);
      reportToolGuardActivity(seen.context);
      await vi.advanceTimersByTimeAsync(200);
      reportToolGuardActivity(seen.context);
      expect(readToolGuardRemainingMs(seen.context)).toBe(100);
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a flat guard flat: activity never extends it', async () => {
    vi.useFakeTimers(FAKE);
    try {
      const { seen, tool } = hangingTool();
      const guarded = guardToolExecution(tool, { timeoutMs: 300, toolName: 'demo' });
      const result = guarded.execute({}, { toolCallId: 'call-1' });
      await vi.advanceTimersByTimeAsync(200);
      expect(toolGuardOwnsInactivity(seen.context)).toBe(false);
      reportToolGuardActivity(seen.context);
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({
        error: { message: formatToolTimeoutMessage(300, undefined) },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
