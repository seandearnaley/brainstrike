import { ToolInputError } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  applyToolGuards,
  type GuardedToolError,
  guardToolExecution,
  isGuardedToolError,
} from '../tools/guard-tool-execution';
import { readToolGuardDeadlineSignal } from '../tools/tool-guard-deadline';

function makeTool(execute: (...args: unknown[]) => unknown) {
  return { description: 'd', execute, id: 'demo' };
}

describe('guardToolExecution', () => {
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
    const context = { agent: { toolCallId: 'call-1' } };
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
    const context = { agent: { toolCallId: 'call-2' } };
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

  it('reports two live executions colliding on one provider tool-call id', async () => {
    // The tool-call id is PROVIDER data, so a collision is a data condition,
    // not a programming error: the guard must keep both calls working and make
    // the mis-routed deadline diagnosable rather than invisible (BST-1594
    // review). Logging, not throwing, is what keeps the call working.
    const logger = { debug: vi.fn(), error: vi.fn() };
    const started = Promise.withResolvers<void>();
    const first = guardToolExecution(
      makeTool(async () => {
        started.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { value: 'first' };
      }),
      { logger, timeoutMs: 5000, toolName: 'demo' }
    );
    const second = guardToolExecution(
      makeTool(async () => ({ value: 'second' })),
      { logger, timeoutMs: 5000, toolName: 'demo' }
    );

    const firstCall = first.execute({}, { agent: { toolCallId: 'shared-call' } });
    await started.promise;
    expect(logger.error).not.toHaveBeenCalled();

    await expect(second.execute({}, { agent: { toolCallId: 'shared-call' } })).resolves.toEqual({
      value: 'second',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Tool guard deadline id collision',
      expect.objectContaining({ toolCallId: 'shared-call' })
    );
    await expect(firstCall).resolves.toEqual({ value: 'first' });
  });

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
});
