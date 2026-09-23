import {
  type DelegatedBudgetPort,
  DelegatedOutputReservationExceededError,
} from '@brainstrike/assistant-contract';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedSynthesisOutcomes,
  readDelegatedSynthesisPart,
} from '../mastra/delegated-synthesis-outcomes';
import {
  createDelegatedWorkBudget,
  DelegatedWorkQueue,
  queueDelegatedTools,
} from '../mastra/delegated-work-budget';
import {
  lengthParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';

async function finish(stream: Awaited<ReturnType<Agent['stream']>>): Promise<void> {
  for await (const _part of stream.fullStream) {
    /* native stream consumption */
  }
  await stream.getFullOutput();
}

describe('native delegated work budget boundaries', () => {
  it('removes tools for reserved synthesis and rejects a provider that still requests an effect', async () => {
    const effect = vi.fn(async () => ({ executed: true }));
    const fixture = scriptedAgentModel((options) => {
      expect(options.maxOutputTokens).toBe(512);
      expect(options.toolChoice).toEqual({ type: 'none' });
      expect(options.tools ?? []).toEqual([]);
      return toolCallParts('effect', 'forged-effect', {});
    });
    const budget: DelegatedBudgetPort = {
      admitInvocation: async () => ({ admitted: true as const }),
      reserveStep: vi.fn(async () => ({
        cap: 'steps' as const,
        id: 'reserved-summary',
        limit: 16,
        outputTokens: 512,
        synthesis: true as const,
        used: 15,
      })),
      settleStep: vi.fn(async () => undefined),
    };
    const work = createDelegatedWorkBudget(budget, new DelegatedWorkQueue(2));
    const memory = new Memory({ storage: new InMemoryStore({ id: 'budget-synthesis' }) });
    const agent = new Agent({
      id: 'worker',
      inputProcessors: [work.processor],
      instructions: 'Complete the task.',
      memory,
      model: fixture.model,
      name: 'Worker',
      outputProcessors: [work.processor],
      tools: {
        effect: createTool({
          description: 'Disposable effect.',
          execute: effect,
          id: 'effect',
          inputSchema: z.object({}),
        }),
      },
    });
    const stream = await agent.stream('Summarize existing work.', {
      maxSteps: 2,
      memory: { resource: 'resource', thread: 'child' },
      onError: () => work.release(),
      onFinish: () => work.release(),
    });
    await expect(finish(stream)).rejects.toThrow(/synthesis|tool/i);
    expect(effect).not.toHaveBeenCalled();
    expect(budget.reserveStep).toHaveBeenCalledExactlyOnceWith({
      resourceId: 'resource',
      threadId: 'child',
    });
  });

  it('settles reported output before tools and does not execute after the host rejects an overage', async () => {
    const effect = vi.fn(async () => ({ executed: true }));
    const fixture = scriptedAgentModel(() => toolCallParts('effect', 'over-budget-effect', {}));
    const budget: DelegatedBudgetPort = {
      admitInvocation: async () => ({ admitted: true as const }),
      reserveStep: vi.fn(async () => ({
        id: 'reservation',
        outputTokens: 8192,
        synthesis: false as const,
      })),
      settleStep: vi.fn(async () => {
        throw new DelegatedOutputReservationExceededError();
      }),
    };
    const work = createDelegatedWorkBudget(budget, new DelegatedWorkQueue(2));
    const agent = new Agent({
      id: 'worker',
      inputProcessors: [work.processor],
      instructions: 'Complete the task.',
      memory: new Memory({ storage: new InMemoryStore({ id: 'budget-overage' }) }),
      model: fixture.model,
      name: 'Worker',
      outputProcessors: [work.processor],
      tools: {
        effect: createTool({
          description: 'Disposable effect.',
          execute: effect,
          id: 'effect',
          inputSchema: z.object({}),
        }),
      },
    });
    await expect(
      finish(
        await agent.stream('Perform the effect.', {
          maxSteps: 2,
          memory: { resource: 'resource', thread: 'child' },
          onError: () => work.release(),
          onFinish: () => work.release(),
        })
      )
    ).rejects.toThrow(/reservation/);
    expect(budget.settleStep).toHaveBeenCalledExactlyOnceWith('reservation', 1);
    expect(effect).not.toHaveBeenCalled();
  });

  it('queues native model work behind two actual tool effects and releases capacity after an error', async () => {
    const thirdRequested = Promise.withResolvers<void>();
    class ObservedQueue extends DelegatedWorkQueue {
      private requests = 0;
      override acquire(signal?: AbortSignal): Promise<() => void> {
        this.requests += 1;
        if (this.requests === 3) {
          thirdRequested.resolve();
        }
        return super.acquire(signal);
      }
    }
    // Two runnable operations: the third (model work) queues behind both effects.
    const queue = new ObservedQueue(2);
    const blockers = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const started = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;
    const execute = vi.fn(async () => {
      const index = active++;
      maximum = Math.max(maximum, active);
      if (active === 2) {
        started.resolve();
      }
      try {
        await blockers[index]?.promise;
      } finally {
        active -= 1;
      }
      if (index === 0) {
        throw new Error('Disposed tool failure');
      }
      return 'done';
    });
    const raw = createTool({
      description: 'Held effect.',
      execute,
      id: 'effect',
      inputSchema: z.object({}),
    });
    const queued = queueDelegatedTools({ effect: raw }, queue, () => undefined)['effect'];
    if (!(queued && 'execute' in queued) || typeof queued.execute !== 'function') {
      throw new Error('Missing queued effect');
    }
    const first = Promise.resolve(queued.execute({}, {})).catch((error: unknown) => error);
    const second = Promise.resolve(queued.execute({}, {}));
    await started.promise;
    const model = scriptedAgentModel(() => textParts('model entered after release'));
    const budget: DelegatedBudgetPort = {
      admitInvocation: async () => ({ admitted: true as const }),
      reserveStep: vi.fn(async () => ({
        id: 'third',
        outputTokens: 512,
        synthesis: false as const,
      })),
      settleStep: vi.fn(async () => undefined),
    };
    const work = createDelegatedWorkBudget(budget, queue);
    const agent = new Agent({
      id: 'worker',
      inputProcessors: [work.processor],
      instructions: 'Answer.',
      memory: new Memory({ storage: new InMemoryStore({ id: 'budget-queue' }) }),
      model: model.model,
      name: 'Worker',
      outputProcessors: [work.processor],
    });
    const third = finish(
      await agent.stream('Answer now.', {
        memory: { resource: 'resource', thread: 'child' },
        onError: () => work.release(),
        onFinish: () => work.release(),
      })
    );
    await thirdRequested.promise;
    expect(model.prompts).toEqual([]);
    blockers[0]?.resolve();
    await third;
    expect(model.prompts).toHaveLength(1);
    expect(maximum).toBe(2);
    blockers[1]?.resolve();
    expect(await first).toBeInstanceOf(Error);
    await second;
  });

  it.each(['persistence', 'uncut'])(
    'does not recover a %s failure on the final summary',
    async (failure) => {
      const fixture = scriptedAgentModel(() =>
        failure === 'uncut' ? textParts('SUMMARY') : lengthParts('PARTIAL')
      );
      const budget: DelegatedBudgetPort = {
        admitInvocation: async () => ({ admitted: true as const }),
        reserveStep: async () => ({
          cap: 'steps',
          id: 'summary',
          limit: 4,
          outputTokens: 1024,
          synthesis: true,
          used: 3,
        }),
        settleStep: async () => {
          throw failure === 'persistence'
            ? new Error('storage failed')
            : new DelegatedOutputReservationExceededError();
        },
      };
      const outcomes = createDelegatedSynthesisOutcomes();
      const work = createDelegatedWorkBudget(
        budget,
        new DelegatedWorkQueue(2),
        undefined,
        outcomes
      );
      const agent = new Agent({
        id: 'worker',
        inputProcessors: [work.processor],
        instructions: 'Summarize.',
        memory: new Memory({ storage: new InMemoryStore({ id: 'summary-failure' }) }),
        model: fixture.model,
        name: 'Worker',
        outputProcessors: [work.processor],
      });
      await expect(
        finish(
          await agent.stream('Summarize.', { memory: { resource: 'resource', thread: 'child' } })
        )
      ).rejects.toThrow(failure === 'persistence' ? /storage failed/ : /Provider exceeded/);
      expect(outcomes.read('child')).toBeUndefined();
      expect(fixture.prompts).toHaveLength(1);
    }
  );

  it.each([512, 1999])(
    'preserves a cut final summary with %i total tokens after settlement',
    async (outputTokens) => {
      const fixture = scriptedAgentModel(() =>
        lengthParts('PARTIAL FINDINGS').map((part) =>
          part.type === 'finish'
            ? { ...part, usage: { inputTokens: 1, outputTokens, totalTokens: outputTokens + 1 } }
            : part
        )
      );
      const budget: DelegatedBudgetPort = {
        admitInvocation: async () => ({ admitted: true as const }),
        reserveStep: vi.fn(async () => ({
          cap: 'steps' as const,
          id: 'reserved-summary',
          limit: 4,
          outputTokens: 1024,
          synthesis: true as const,
          used: 3,
        })),
        settleStep: vi.fn(async () => {
          if (outputTokens > 1024) {
            throw new DelegatedOutputReservationExceededError();
          }
        }),
      };
      const outcomes = createDelegatedSynthesisOutcomes();
      const work = createDelegatedWorkBudget(
        budget,
        new DelegatedWorkQueue(2),
        undefined,
        outcomes
      );
      const agent = new Agent({
        id: 'worker',
        inputProcessors: [work.processor],
        instructions: 'Summarize.',
        memory: new Memory({ storage: new InMemoryStore({ id: 'budget-truncated' }) }),
        model: fixture.model,
        name: 'Worker',
        outputProcessors: [work.processor],
      });
      const stream = await agent.stream('Summarize existing work.', {
        maxSteps: 2,
        memory: { resource: 'resource', thread: 'child' },
        onError: () => work.release(),
        onFinish: () => work.release(),
      });
      const parts: unknown[] = [];
      for await (const part of stream.fullStream) {
        parts.push(part);
      }
      await stream.getFullOutput();
      expect(outcomes.read('child')).toEqual({
        cap: 'steps',
        limit: 4,
        outputTokens,
        reservedOutputTokens: 1024,
        truncated: true,
        used: 3,
      });
      const published = parts.map(readDelegatedSynthesisPart).filter(Boolean);
      expect(published).toEqual([
        {
          cap: 'steps',
          limit: 4,
          outputTokens,
          reservedOutputTokens: 1024,
          resourceId: 'resource',
          threadId: 'child',
          truncated: true,
          used: 3,
        },
      ]);
      expect(budget.settleStep).toHaveBeenCalledExactlyOnceWith('reserved-summary', outputTokens);
      expect(fixture.prompts).toHaveLength(1);
    }
  );

  it('records a synthesis that finished normally as NOT truncated, and nothing for an ordinary step', async () => {
    const fixture = scriptedAgentModel(() => textParts('COMPLETE SUMMARY'));
    let synthesis = false;
    const budget: DelegatedBudgetPort = {
      admitInvocation: async () => ({ admitted: true as const }),
      reserveStep: vi.fn(async () =>
        synthesis
          ? {
              cap: 'child-output' as const,
              id: 's',
              limit: 32_768,
              outputTokens: 2048,
              synthesis: true as const,
              used: 32_768,
            }
          : { id: 'w', outputTokens: 8192, synthesis: false as const }
      ),
      settleStep: vi.fn(async () => undefined),
    };
    const outcomes = createDelegatedSynthesisOutcomes();
    const run = async (thread: string) => {
      const work = createDelegatedWorkBudget(
        budget,
        new DelegatedWorkQueue(2),
        undefined,
        outcomes
      );
      const agent = new Agent({
        id: 'worker',
        inputProcessors: [work.processor],
        instructions: 'Answer.',
        memory: new Memory({ storage: new InMemoryStore({ id: `budget-${thread}` }) }),
        model: fixture.model,
        name: 'Worker',
        outputProcessors: [work.processor],
      });
      await finish(
        await agent.stream('Answer.', {
          maxSteps: 2,
          memory: { resource: 'resource', thread },
          onError: () => work.release(),
          onFinish: () => work.release(),
        })
      );
    };
    await run('ordinary');
    expect(outcomes.read('ordinary')).toBeUndefined();
    synthesis = true;
    await run('summary');
    expect(outcomes.read('summary')).toEqual({
      cap: 'child-output',
      limit: 32_768,
      outputTokens: 1,
      reservedOutputTokens: 2048,
      truncated: false,
      used: 32_768,
    });
  });
});
