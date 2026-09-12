import { AdmittedChildConfigurationError } from '@brainstrike/assistant-contract';
import { expect, it } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from '../mastra/agent-streaming';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

async function suspend(fixture: Awaited<ReturnType<typeof createBackgroundFixture>>) {
  fixture.release.resolve();
  const initial = await createStreamIteratorFromRuntime({
    memory: fixture.backing.memory,
    messages: [
      { id: 'snapshot-task', parts: [{ text: 'Inspect evidence', type: 'text' }], role: 'user' },
    ],
    runtime: fixture.runtime,
    runtimeData: fixture.runtimeData,
  });
  for await (const _chunk of initial) {
    /* Drain the native suspension before disposing its original execution owner. */
  }
  await fixture.runtime.dispose();
}

it.each([
  { edited: false, question: false },
  { edited: true, question: false },
  { edited: false, question: true },
  { edited: true, question: true },
])(
  'restores admitted persona after runtime disposal with an edited or removed registry (edited=$edited, question=$question)',
  async ({ edited, question }) => {
    const fixture = await createBackgroundFixture(!question, undefined, question);
    const { database, discoveryOptions, effect, model, scope } = fixture;
    try {
      await suspend(fixture);
      const original = discoveryOptions.personas?.[0];
      if (!original) {
        throw new Error('Missing admitted test persona');
      }
      const options = {
        ...discoveryOptions,
        personas: edited
          ? [{ ...original, allowedToolIds: [], instructions: 'MUTATED_LIVE_PROFILE', maxSteps: 1 }]
          : [],
      };
      // Reload discovers identity-only native snapshots, independent of the edited registry.
      const pending = await listSuspendedMastraRuns(scope, options);
      const target = question ? pending.suspends[0] : pending.approvals[0];
      if (!target?.delegation) {
        throw new Error('Missing delegated decision');
      }
      const address = {
        delegation: target.delegation,
        runId: target.runId,
        toolCallId: target.toolCallId,
      };
      const resumePromptIndex = model.prompts.length;
      const resumed = question
        ? await streamMastraToolResumeAction(
            { ...address, resumeData: { answer: 'Original evidence' } },
            options
          )
        : await streamMastraToolApprovalAction({ ...address, action: 'approve' }, options);
      const chunks: StreamChunk[] = [];
      for await (const chunk of resumed) {
        chunks.push(chunk);
      }
      expect(effect).toHaveBeenCalledOnce();
      expect(
        chunks
          .filter((chunk) => chunk.type === 'text-delta')
          .map((chunk) => chunk.value)
          .join('')
      ).toContain('PARENT_FINAL_OUTCOME');
      const childText = chunks.flatMap((chunk) =>
        chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'text-delta'
          ? [chunk.chunk.value]
          : []
      );
      expect(childText.join('')).toBe('CHILD_FINAL_EVIDENCE');
      const resumedPrompts = model.prompts.slice(resumePromptIndex);
      expect(JSON.stringify(resumedPrompts)).not.toContain('MUTATED_LIVE_PROFILE');
      expect(JSON.stringify(resumedPrompts)).toContain(original.instructions);
      const childCalls = resumedPrompts.filter(
        (call) => !call.tools?.some((tool) => tool.name === 'agent-explore')
      );
      expect(childCalls.length).toBeGreaterThan(0);
      expect(
        childCalls.some((call) =>
          call.tools?.some((tool) => tool.name === 'brainstrike_grepSearch')
        )
      ).toBe(true);
    } finally {
      fixture.release.resolve();
      await fixture.runtime.dispose();
      await database.close();
    }
  }
);

it('rejects a revoked host tool before resuming an admitted child', async () => {
  const fixture = await createBackgroundFixture(true);
  try {
    await suspend(fixture);
    const pending = await listSuspendedMastraRuns(fixture.scope, fixture.discoveryOptions);
    const target = pending.approvals[0];
    if (!target?.delegation) {
      throw new Error('Missing delegated approval');
    }
    await expect(
      streamMastraToolApprovalAction(
        {
          action: 'approve',
          delegation: target.delegation,
          runId: target.runId,
          toolCallId: target.toolCallId,
        },
        { ...fixture.discoveryOptions, personas: [], tools: {} }
      )
    ).rejects.toMatchObject({
      constructor: AdmittedChildConfigurationError,
      reason: 'model-or-tools-unavailable',
    });
    expect(fixture.effect).not.toHaveBeenCalled();
  } finally {
    fixture.release.resolve();
    await fixture.runtime.dispose();
    await fixture.database.close();
  }
});

it('captures the first native child execution and resumes that exact model and effort after root changes', async () => {
  const fixture = await createBackgroundFixture(true);
  try {
    await fixture.runtime.dispose();
    fixture.runtimeData = {
      ...fixture.runtimeData,
      modelSettings: { maxOutputTokens: 777 },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    };
    fixture.runtime = await createMastraAgentRuntime({
      ...fixture.discoveryOptions,
      model: 'gpt-5.4',
      runtime: fixture.runtimeData,
    });
    await suspend(fixture);
    const pending = await listSuspendedMastraRuns(fixture.scope, fixture.discoveryOptions);
    const target = pending.approvals[0];
    if (!target?.delegation) {
      throw new Error('Expected first child approval');
    }
    const address = {
      delegation: target.delegation,
      runId: target.runId,
      toolCallId: target.toolCallId,
    };
    const scopes = await fixture.discoveryOptions.conversationBinding?.resolveToolAction?.(address);
    expect(scopes?.[0]?.configuration).toMatchObject({
      execution: {
        model: 'gpt-5.4',
        modelSettings: { maxOutputTokens: 777 },
        planMode: false,
        provider: 'openai',
        providerOptions: { openai: { reasoningEffort: 'high' } },
      },
    });
    expect(fixture.model.prompts[1]).toMatchObject({
      maxOutputTokens: 777,
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    const resumeIndex = fixture.model.prompts.length;
    const resumed = await streamMastraToolApprovalAction(
      { ...address, action: 'approve' },
      {
        ...fixture.discoveryOptions,
        model: 'gpt-5.4',
        runtime: {
          ...fixture.runtimeData,
          model: 'gpt-5.4',
          modelSettings: { maxOutputTokens: 42 },
          providerOptions: { openai: { reasoningEffort: 'low' } },
        },
      }
    );
    for await (const _chunk of resumed) {
      /* drain native owner */
    }
    expect(fixture.effect).toHaveBeenCalledOnce();
    const resumedCalls = fixture.model.prompts.slice(resumeIndex);
    expect(resumedCalls[0]).toMatchObject({
      maxOutputTokens: 777,
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    expect(resumedCalls.at(-1)).toMatchObject({
      maxOutputTokens: 42,
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
  } finally {
    fixture.release.resolve();
    await fixture.runtime.dispose();
    await fixture.database.close();
  }
});
