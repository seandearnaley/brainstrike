import { describe, expect, it, vi } from 'vitest';
import {
  applyToolGuards,
  type GuardedToolError,
  guardToolExecution,
  isGuardedToolError,
} from '../tools/guard-tool-execution';

function makeTool(execute: (...args: unknown[]) => unknown) {
  return { id: 'demo', description: 'd', execute };
}

describe('guardToolExecution', () => {
  it('passes through a successful result unchanged', async () => {
    const tool = guardToolExecution(
      makeTool(async () => ({ value: 42 })),
      {
        toolName: 'demo',
        timeoutMs: 1000,
      }
    );
    await expect(tool.execute({ context: {} })).resolves.toEqual({ value: 42 });
  });

  it('returns a structured timeout error when execute never resolves', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      { toolName: 'demo', timeoutMs: 50 }
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
      { toolName: 'demo', timeoutMs: 1000, logger }
    );
    const result = (await tool.execute({ context: {} })) as GuardedToolError;
    expect(result.error.code).toBe('tool_failed');
    expect(result.error.message).not.toContain('SECRET');
    expect(logger.error).toHaveBeenCalled();
  });

  it('leaves a tool without an execute function untouched', () => {
    const noExec = { id: 'x', description: 'd' } as { id: string; description: string };
    expect(guardToolExecution(noExec, { toolName: 'x', timeoutMs: 1000 })).toBe(noExec);
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
      { toolName: 'demo', timeoutMs: 50, logger }
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
      a: { id: 'a', description: 'd', execute: () => new Promise(() => {}) },
      b: { id: 'b', description: 'd', execute: async () => ({ ok: true }) },
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
