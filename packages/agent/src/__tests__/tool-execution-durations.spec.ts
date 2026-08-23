import { describe, expect, it, vi } from 'vitest';
import { applyToolGuards, guardToolExecution } from '../tools/guard-tool-execution';
import { createToolExecutionDurations } from '../tools/tool-execution-durations';

/** Mastra passes the tool input first and a context carrying the call id second. */
const ctx = (toolCallId: string) => [{ q: 1 }, { toolCallId }] as const;

describe('tool execution durations', () => {
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
    // Mirrors readToolCallId in tool-output-artifact-settlement.ts: Mastra has
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
