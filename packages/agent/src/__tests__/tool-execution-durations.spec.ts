import { describe, expect, it, vi } from 'vitest';
import { applyToolGuards, guardToolExecution } from '../tools/guard-tool-execution';
import { applyToolHooks } from '../tools/hook-tool-wrap';
import { createToolExecutionDurations } from '../tools/tool-execution-durations';

/** Mastra passes the tool input first and a context carrying the call id second. */
const ctx = (toolCallId: string) => [{ q: 1 }, { toolCallId }] as const;

describe('tool execution durations', () => {
  it('keeps reused tool-call ids isolated by the native execution thread', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const durations = createToolExecutionDurations();
    const guarded = guardToolExecution(
      {
        execute: async (elapsed: number, ..._args: unknown[]) => {
          now += elapsed;
          return { ok: true };
        },
      },
      { durations, timeoutMs: 5000, toolName: 't' }
    );
    try {
      await guarded.execute(11, { agent: { threadId: 'child-a', toolCallId: 'same' } });
      await guarded.execute(29, { agent: { threadId: 'child-b', toolCallId: 'same' } });
      await guarded.execute(7, { agent: { threadId: 'root', toolCallId: 'same' } });
      expect(durations.read('same', 'child-a')).toBe(11);
      expect(durations.read('same', 'child-b')).toBe(29);
      expect(durations.read('same', 'root')).toBe(7);
      expect(durations.read('same')).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('records the time execute actually ran, keyed by tool-call id', async () => {
    // This wrapper is the only place that sees real execution time. Everything
    // downstream can only see stream timestamps, which for an approval-gated
    // call span the human wait.
    const durations = createToolExecutionDurations();
    const tool = {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    };
    const guarded = guardToolExecution(tool, { durations, timeoutMs: 5000, toolName: 't' });

    await guarded.execute(...ctx('call-1'));

    const recorded = durations.read('call-1');
    expect(recorded).toBeGreaterThanOrEqual(15);
    expect(recorded).toBeLessThan(5000);
  });

  it('reads the toolCallId from the nested agent context too', async () => {
    // Mirrors readToolCallId in tools/read-tool-call-id.ts: Mastra has
    // put the id in both places across versions.
    const durations = createToolExecutionDurations();
    const guarded = guardToolExecution(
      { execute: async () => ({ ok: true }) },
      { durations, timeoutMs: 5000, toolName: 't' }
    );

    await guarded.execute({ q: 1 }, { agent: { toolCallId: 'call-nested' } });

    expect(durations.read('call-nested')).toBeDefined();
  });

  it('records a FAILED call, because its terminal event needs a number too', async () => {
    const durations = createToolExecutionDurations();
    const guarded = guardToolExecution(
      {
        execute: async () => {
          throw new Error('boom');
        },
      },
      { durations, logger: { error: vi.fn() } as never, timeoutMs: 5000, toolName: 't' }
    );

    await guarded.execute(...ctx('call-fail'));

    expect(durations.read('call-fail')).toBeDefined();
  });

  it('records nothing when no recorder is supplied', async () => {
    // NO SILENT FABRICATION: absent means the pre-existing behaviour, not a
    // manufactured duration.
    const durations = createToolExecutionDurations();
    const guarded = guardToolExecution(
      { execute: async () => ({ ok: true }) },
      { timeoutMs: 5000, toolName: 't' }
    );

    await guarded.execute(...ctx('call-none'));

    expect(durations.read('call-none')).toBeUndefined();
  });

  it('records nothing when the call carries no id', async () => {
    const durations = createToolExecutionDurations();
    const guarded = guardToolExecution(
      { execute: async () => ({ ok: true }) },
      { durations, timeoutMs: 5000, toolName: 't' }
    );

    await guarded.execute({ q: 1 }, {});

    expect(durations.read('')).toBeUndefined();
  });

  it('threads the recorder through applyToolGuards', async () => {
    // The wiring, not the arithmetic: a regression that drops `durations` from
    // the per-tool options would leave every unit above green.
    const durations = createToolExecutionDurations();
    const guarded = applyToolGuards(
      { myTool: { execute: async () => ({ ok: true }) } },
      { durations, timeoutMs: 5000 }
    );

    await (guarded.myTool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(
      ...ctx('call-map')
    );

    expect(durations.read('call-map')).toBeDefined();
  });
});

describe('hook short-circuits still record a duration', () => {
  const hookRunner = (decision: 'allow' | 'block') =>
    ({
      postToolUse: async () => ({ decision: 'allow' }),
      preToolUse: async () => ({ decision, reason: 'denied by policy' }),
    }) as never;

  it('records when a PreToolUse hook BLOCKS the call', async () => {
    // applyToolHooks composes OUTSIDE the guard, so a block returns without
    // ever invoking the guarded execute — leaving no recorded duration. The
    // consumer then falls back to the start-to-terminal gap, which for an
    // approval-gated call still reports the whole human wait as execution.
    //
    // The recorded number is small by construction (the hook ran, the tool did
    // not). That is the point: an honest small number beats a fallback that
    // bills the approval delay.
    const durations = createToolExecutionDurations();
    const hooked = applyToolHooks(
      { myTool: { execute: async () => ({ ran: true }) } },
      {
        durations,
        hookRunner: hookRunner('block'),
        toolNameMap: new Map([['myTool', 'brainstrike.myTool']]),
      }
    );

    await (hooked.myTool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(
      ...ctx('call-blocked')
    );

    expect(durations.read('call-blocked')).toBeDefined();
  });

  it('does not overwrite the guard measurement when the hook ALLOWS', async () => {
    // An allowed call must report the real execution time, not the hook
    // wrapper's own overhead.
    const durations = createToolExecutionDurations();
    const guarded = applyToolGuards(
      {
        myTool: {
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { ran: true };
          },
        },
      },
      { durations, timeoutMs: 5000 }
    );
    const hooked = applyToolHooks(guarded, {
      durations,
      hookRunner: hookRunner('allow'),
      toolNameMap: new Map([['myTool', 'brainstrike.myTool']]),
    });

    await (hooked.myTool as { execute: (...a: unknown[]) => Promise<unknown> }).execute(
      ...ctx('call-allowed')
    );

    expect(durations.read('call-allowed')).toBeGreaterThanOrEqual(15);
  });
});
