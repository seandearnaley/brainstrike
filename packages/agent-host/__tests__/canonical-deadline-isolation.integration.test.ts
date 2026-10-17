import { resolveGuardedToolSignal } from '@brainstrike/agent';
import {
  type HostToolDefinition,
  type HostToolExecutionContext,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { effectToolInputSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import { Schema } from 'effect';
import { expect, test, vi } from 'vitest';
import { createAgentHostToolBindings } from '../src/adapters/canonical-tool-bindings.js';
import type { HostToolContext } from '../src/ports.js';

test('canonical native bindings isolate delayed deadline lookup across root and child runs', async () => {
  vi.useFakeTimers();
  const lookup = Promise.withResolvers<void>();
  const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const contexts: HostToolExecutionContext[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const writes: unknown[] = [];
  const caller = new AbortController();
  const write = async (value: unknown): Promise<void> => {
    writes.push(value);
  };
  const producer: HostToolDefinition = {
    description: 'Occurrence cancellation fixture',
    execute: async (_input, context) => {
      if (!context) {
        throw new Error('Missing host execution context');
      }
      const index = contexts.length;
      contexts.push(context);
      await lookup.promise;
      signals[index] = resolveGuardedToolSignal(context);
      await context.writer?.custom({ runId: context.runId });
      ready[index]?.resolve();
      await finish[index]?.promise;
      return { ok: true };
    },
    id: NATIVE_TOOL_ID.manageTaskList,
    inputSchema: effectToolInputSchema(Schema.Struct({})),
  };
  const bind = (toolTimeoutMs: number) => {
    const bindings = createAgentHostToolBindings({
      bindings: {
        [NATIVE_TOOL_ID.manageTaskList]: { identity: 'native-generation-1', risk: 'read' },
      },
      resolvedToolResultBudget: resolveScaledToolResultBudget(128_000),
      tools: { [NATIVE_TOOL_ID.manageTaskList]: producer },
      toolTimeoutMs,
    });
    const tool = Object.values(bindings.tools)[0];
    if (!tool) {
      throw new Error('No native binding');
    }
    return tool;
  };
  const context: HostToolContext = {
    runId: 'root-run',
    signal: caller.signal,
    threadId: 'root-thread',
    toolCallId: 'call_1',
    write,
  };
  const first = bind(50).execute({}, context);
  const second = bind(5000).execute(
    {},
    { ...context, runId: 'child-run', threadId: 'child-thread' }
  );
  try {
    lookup.resolve();
    await Promise.all(ready.map((gate) => gate.promise));
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    for (const forwarded of contexts) {
      expect(forwarded.abortSignal).toBe(caller.signal);
      expect(forwarded.writer?.custom).toBe(write);
      expect(forwarded.toolCallId).toBe('call_1');
    }
    expect(writes).toEqual([{ runId: 'root-run' }, { runId: 'child-run' }]);
    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toMatchObject({ error: { code: 'tool_timeout' }, ok: false });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    finish[1]?.resolve();
    await expect(second).resolves.toEqual({ ok: true });
  } finally {
    lookup.resolve();
    for (const gate of finish) {
      gate.resolve();
    }
    await Promise.all([first, second]);
    vi.useRealTimers();
  }
});
