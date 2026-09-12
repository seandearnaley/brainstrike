import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract';
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
    { maxSteps: 17, persona },
    { maxSteps: 3, persona: { ...persona, id: 'sibling' } },
    { maxSteps: 3, persona: { ...persona, mode: 'administrator' } },
    { maxSteps: 3, persona: { ...persona, instructions: '' } },
  ])('refuses a missing or invalid stored configuration %#', async (configuration) => {
    await expect(readDelegatedPersonaSnapshots(action, binding(configuration))).rejects.toThrow(
      'admitted child configuration'
    );
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
