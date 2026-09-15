import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract';
import { SUBAGENT_SETTINGS_LIMITS } from '@brainstrike/assistant-contract/subagent-settings';
import { describe, expect, it, vi } from 'vitest';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import {
  personasAtDelegationDepth,
  readDelegatedPersonaSnapshots,
  withDelegatedPersonaSnapshots,
} from '../delegated-persona-snapshots';

const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Read evidence',
  id: 'reader',
  instructions: '  Original instructions\n',
  label: 'Reader',
  maxSteps: 8,
};
const identity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'parent-call',
  personaId: 'reader',
};
const action = {
  delegation: { path: [identity], toolCallId: 'leaf-call' },
  runId: 'parent-run',
  toolCallId: 'parent-call',
};
const binding = (configuration: unknown) => ({
  ...createDelegatedConversationBinding(async () => {}),
  resolveToolAction: async () => [
    { configuration, identity, resourceId: 'owner', threadId: 'child' },
  ],
});

describe('admitted persona restoration', () => {
  it('uses the effective admitted step budget and preserves the instruction text', async () => {
    expect(await readDelegatedPersonaSnapshots(action, binding({ maxSteps: 3, persona }))).toEqual([
      { ...persona, maxSteps: 3 },
    ]);
  });

  it.each([
    undefined,
    { maxSteps: 0, persona },
    // One past the admitted ceiling, which is the settings ceiling (64), not a persona default.
    { maxSteps: SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max + 1, persona },
    { maxSteps: 3, persona: { ...persona, id: 'sibling' } },
    { maxSteps: 3, persona: { ...persona, mode: 'administrator' } },
    { maxSteps: 3, persona: { ...persona, instructions: '' } },
  ])('refuses a missing or invalid stored configuration %#', async (configuration) => {
    await expect(readDelegatedPersonaSnapshots(action, binding(configuration))).rejects.toThrow(
      'admitted child configuration'
    );
  });

  it.each([
    { ...persona, format: 'unrecognized' },
    { ...persona, model: { modelId: 'model', provider: 'unrecognized' } },
    { ...persona, allowedToolIds: [] },
  ])('refuses an unsupported or incomplete admitted persona %#', async (stored) => {
    await expect(
      readDelegatedPersonaSnapshots(action, binding({ maxSteps: 3, persona: stored }))
    ).rejects.toThrow('Start a new delegation');
  });

  it('keeps replacement order and does not manufacture an empty credential map', async () => {
    const sibling = { ...persona, id: 'sibling' };
    expect(personasAtDelegationDepth([persona, sibling], [{ ...persona, maxSteps: 2 }])).toEqual([
      { ...persona, maxSteps: 2 },
      sibling,
    ]);
    const restored = await withDelegatedPersonaSnapshots(action, {
      conversationBinding: binding({ maxSteps: 3, persona }),
      runtime: { model: 'gpt-5.4', provider: 'openai' },
    });
    expect(restored.runtime).not.toHaveProperty('personaProviderApiKeys');
  });

  it('requires root runtime before reading a credential that could not be applied', async () => {
    const resolvePersonaApiKey = vi.fn(async () => 'unused-secret');
    await expect(
      withDelegatedPersonaSnapshots(action, {
        conversationBinding: binding({
          maxSteps: 3,
          persona: {
            ...persona,
            model: { modelId: 'claude-sonnet-4-6', provider: 'anthropic' },
          },
        }),
        resolvePersonaApiKey,
      })
    ).rejects.toThrow('root runtime');
    expect(resolvePersonaApiKey).not.toHaveBeenCalled();
  });

  it('refuses a legacy wildcard snapshot instead of widening it to the current catalog', async () => {
    await expect(
      readDelegatedPersonaSnapshots(
        action,
        binding({ maxSteps: 3, persona: { ...persona, allowedToolIds: ['*'], mode: 'worker' } })
      )
    ).rejects.toThrow('no captured tool catalog');
  });

  it('never restores a read-only declaration with a write tool', async () => {
    await expect(
      readDelegatedPersonaSnapshots(
        action,
        binding({
          maxSteps: 3,
          persona: { ...persona, allowedToolIds: ['brainstrike.writeWorkspaceFile'] },
        })
      )
    ).rejects.toThrow('not');
  });

  it('requires the host authorization before reading configuration', async () => {
    await expect(readDelegatedPersonaSnapshots(action, undefined)).rejects.toThrow(
      'host-owned ancestry'
    );
    const denied = {
      ...binding({ maxSteps: 3, persona }),
      resolveToolAction: async () => {
        throw new Error('Wrong root owner');
      },
    };
    await expect(readDelegatedPersonaSnapshots(action, denied)).rejects.toThrow('Wrong root owner');
  });

  it('keeps different admitted definitions of the same persona id at their own depth', () => {
    const root = { ...persona, instructions: 'live registry' };
    const first = { ...persona, instructions: 'child admitted first' };
    const second = { ...persona, instructions: 'grandchild admitted later' };
    expect(personasAtDelegationDepth([root], [first, second], 1)).toEqual([first]);
    expect(personasAtDelegationDepth([root], [first, second], 2)).toEqual([second]);
    expect(personasAtDelegationDepth([root], [first, second], 3)).toEqual([root]);
  });

  it('reacquires cross-provider credentials for a removed admitted profile without persisting secrets', async () => {
    const pinned = { ...persona, model: { modelId: 'claude-sonnet-4-6', provider: 'anthropic' } };
    const configuration = { maxSteps: 3, persona: pinned };
    const resolvePersonaApiKey = vi.fn(async () => 'current-host-key');
    const restored = await withDelegatedPersonaSnapshots(action, {
      conversationBinding: binding(configuration),
      personas: [],
      resolvePersonaApiKey,
      runtime: { model: 'gpt-5.4', provider: 'openai' },
    });
    expect(resolvePersonaApiKey).toHaveBeenCalledExactlyOnceWith('anthropic');
    expect(restored.runtime?.personaProviderApiKeys).toEqual({ anthropic: 'current-host-key' });
    expect(restored.delegatedPersonaSnapshots?.[0]?.model).toEqual(pinned.model);
    expect(JSON.stringify(configuration)).not.toContain('current-host-key');
  });
});

it('keeps separate executed models and generation settings for the same persona at each admitted depth', async () => {
  const first = {
    model: 'gpt-5.4',
    planMode: false,
    provider: 'openai',
    providerOptions: { openai: { reasoningEffort: 'high' } },
  };
  const second = {
    model: 'claude-sonnet-4-6',
    planMode: false,
    provider: 'anthropic',
    providerOptions: { anthropic: { effort: 'low' } },
  };
  const scopedBinding = {
    ...binding({ maxSteps: 3, persona }),
    resolveToolAction: async () =>
      [first, second].map((execution, index) => ({
        configuration: { execution, maxSteps: 3, persona },
        identity,
        resourceId: 'owner',
        threadId: `child-${index}`,
      })),
  };
  const resolvePersonaApiKey = vi.fn(async () => 'owned-current-secret');
  const restored = await withDelegatedPersonaSnapshots(
    {
      ...action,
      delegation: {
        ...action.delegation,
        path: [identity, { ...identity, parentToolCallId: 'second-call' }],
      },
    },
    {
      conversationBinding: scopedBinding,
      resolvePersonaApiKey,
      runtime: { model: 'gpt-5.6-sol', provider: 'openai' },
    }
  );
  expect(restored.delegatedExecutionSnapshots).toEqual([first, second]);
  expect(restored.delegatedPersonaSnapshots?.map((entry) => entry.model)).toEqual([
    { modelId: first.model, provider: first.provider },
    { modelId: second.model, provider: second.provider },
  ]);
  expect(resolvePersonaApiKey).toHaveBeenCalledWith('anthropic');
});

it('keeps invalid execution snapshots behind the fixed public configuration error', async () => {
  await expect(
    withDelegatedPersonaSnapshots(action, {
      conversationBinding: binding({
        execution: { model: 'private-value', planMode: false, provider: 'unknown-provider' },
        maxSteps: 3,
        persona,
      }),
      runtime: { model: 'gpt-5.4', provider: 'openai' },
    })
  ).rejects.toThrow('The admitted child configuration is missing or unsupported.');
});
