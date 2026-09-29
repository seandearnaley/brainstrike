import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { Agent } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { createDelegationConfig } from '../mastra/subagent-delegation';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

const persona = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Read evidence',
  id: 'explore',
  instructions: 'Read evidence',
  label: 'Explorer',
  maxSteps: 32,
};

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe('subagent settings in the delegation config', () => {
  it('clamps a child to min(persona, settings) and lets the model ask for less', async () => {
    // One config per start: the in-flight counter (`maxConcurrentWork`) would
    // otherwise be what refuses a later start, not the step cap under test.
    const start = async (maxSteps?: number) =>
      createDelegationConfig({
        abortSignal: new AbortController().signal,
        logger: logger as never,
        personasById: new Map([[persona.id, persona]]),
        subagentSettings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 12 },
      }).onDelegationStart?.({
        params: { ...(maxSteps === undefined ? {} : { maxSteps }) },
        primitiveId: 'explore',
        primitiveType: 'agent',
        prompt: 'Survey',
        requestContext: new Map() as never,
        runId: 'run',
        toolCallId: `call-${maxSteps ?? 'default'}`,
      } as never);
    expect(await start()).toMatchObject({ modifiedMaxSteps: 12, proceed: true });
    expect(await start(4)).toMatchObject({ modifiedMaxSteps: 4, proceed: true });
    expect(await start(64)).toMatchObject({ modifiedMaxSteps: 12, proceed: true });
  });
});

describe('subagent settings on the runtime', () => {
  it('defaults when the request omits them and tells the model the effective budget', async () => {
    const fixture = await createBackgroundFixture(false, undefined, false, undefined, false, 1, {
      requestOmitsSubagentSettings: true,
    });
    const { backing, runtime, runtimeData, release, database, model } = fixture;
    release.resolve();
    try {
      expect(runtime.subagentSettings).toEqual(DEFAULT_RUNTIME_SUBAGENT_SETTINGS);
      for await (const _chunk of await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'budget-prompt', parts: [{ text: 'Survey', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      })) {
        /* drain */
      }
      // The fixture persona declares 4 steps; 4 < 32, so BOTH places the model
      // reads the budget (the agent-explore tool description and the
      // supervisor instructions) say 4, and the per-child output ceiling is
      // the default 32,768.
      const parentPrompt = model.prompts.find((prompt) =>
        prompt.tools?.some((tool) => tool.name === 'agent-explore')
      );
      const tool = parentPrompt?.tools?.find((candidate) => candidate.name === 'agent-explore');
      expect(tool && 'description' in tool ? tool.description : '').toContain(
        'Runs at most 4 steps'
      );
      expect(tool && 'description' in tool ? tool.description : '').toContain(
        '32768 output tokens per child'
      );
      expect(JSON.stringify(parentPrompt?.prompt)).toContain('Runs at most 4 steps');
    } finally {
      release.resolve();
      await runtime.dispose();
      await database.close();
    }
  });

  it('a request setting of 2 steps caps the same 4-step persona at 2', async () => {
    const fixture = await createBackgroundFixture();
    const { discoveryOptions, database, runtime } = fixture;
    try {
      const capped = await createMastraAgentRuntime({
        ...discoveryOptions,
        runtime: {
          ...discoveryOptions.runtime,
          subagentSettings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 2 },
        },
      });
      try {
        expect(capped.subagentSettings.maxChildSteps).toBe(2);
        expect(capped.instructionBreakdown).toBeDefined();
      } finally {
        await capped.dispose();
      }
    } finally {
      await runtime.dispose();
      await database.close();
    }
  });

  it("a later leg keeps the turn row's limits for wakeups, recursion and the description", async () => {
    // Worker children with a durable budget may recurse; the row allows ONE
    // level and 8 invocations while this leg's request asks for 5 and 2.
    const fixture = await createBackgroundFixture(false, undefined, false, undefined, true, 1, {
      durableWork: true,
    });
    const { discoveryOptions, database, runtime } = fixture;
    const binding = discoveryOptions.conversationBinding;
    const budget = binding?.budget;
    if (!(binding && budget)) {
      throw new Error('The durable-work fixture must carry a budget port');
    }
    const row = {
      maxChildOutputTokens: 16_384,
      maxChildSteps: 40,
      maxDepth: 1,
      maxInvocations: 8,
      maxStepOutputTokens: 4096,
      maxTreeOutputTokens: 131_072,
      synthesisOutputTokens: 1024,
    };
    try {
      const later = await createMastraAgentRuntime({
        ...discoveryOptions,
        conversationBinding: { ...binding, budget: { ...budget, readTurnLimits: async () => row } },
        runtime: {
          ...discoveryOptions.runtime,
          subagentSettings: {
            ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
            maxChildRuntimeMs: 60_000,
            maxConcurrentWork: 3,
            maxDepth: 5,
            maxInvocations: 2,
          },
        },
      });
      try {
        // The idle loop's wakeup bound and every other consumer read this.
        expect(later.subagentSettings).toEqual({
          ...row,
          maxChildRuntimeMs: 60_000,
          maxConcurrentWork: 3,
        });
        const child = (await later.agent.listAgents())['explore'];
        if (!(child instanceof Agent)) {
          throw new Error('Expected the worker persona child');
        }
        expect(child.getDescription()).toContain(
          'The root turn permits at most 1 descendant levels, 8 invocations, 3 active work operations, 16384 output tokens per child and 131072 across descendants.'
        );
        // Depth 1 of the row's 1: the child cannot delegate further.
        expect(Object.keys(await child.listAgents())).toEqual([]);
      } finally {
        await later.dispose();
      }
    } finally {
      await runtime.dispose();
      await database.close();
    }
  });

  it('a malformed request field fails runtime construction loudly', async () => {
    const fixture = await createBackgroundFixture();
    try {
      await expect(
        createMastraAgentRuntime({
          ...fixture.discoveryOptions,
          runtime: {
            ...fixture.discoveryOptions.runtime,
            subagentSettings: { maxChildSteps: 0 } as never,
          },
        })
      ).rejects.toThrow(/Subagent settings are malformed/);
    } finally {
      await fixture.runtime.dispose();
      await fixture.database.close();
    }
  });
});
