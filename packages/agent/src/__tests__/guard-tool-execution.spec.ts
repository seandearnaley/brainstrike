import { describe, expect, it, vi } from 'vitest';
import {
  applyToolGuards,
  type GuardedToolError,
  guardToolExecution,
  isGuardedToolError,
} from '../tools/guard-tool-execution';

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
      a: { description: 'd', execute: () => new Promise(() => {}), id: 'a' },
      b: { description: 'd', execute: async () => ({ ok: true }), id: 'b' },
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
