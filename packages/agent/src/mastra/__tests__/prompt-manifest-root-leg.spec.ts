import { describe, expect, it } from 'vitest';
import { buildRootLegPromptManifest } from '../prompt-manifest-root-leg';

describe('buildRootLegPromptManifest', () => {
  it('captures only host system text, the leg model and the tools the agent registered', () => {
    const manifest = buildRootLegPromptManifest({
      messages: [
        { id: 's1', parts: [{ text: 'You are Brainstrike.', type: 'text' }], role: 'system' },
        { id: 'u1', parts: [{ text: 'hello', type: 'text' }], role: 'user' },
      ],
      registeredToolNames: ['brainstrike.grepSearch'],
      runtime: {
        memory: { resourceId: 'r', threadId: 'thread-1' },
        model: 'z-ai/glm-5.2',
        provider: 'openrouter',
      },
    });
    expect(manifest).toEqual({
      kind: 'root-leg',
      model: 'z-ai/glm-5.2',
      provider: 'openrouter',
      systemContextSource: 'captured',
      systemMessages: [{ content: 'You are Brainstrike.', role: 'system' }],
      threadId: 'thread-1',
      toolNames: ['brainstrike.grepSearch'],
    });
  });

  it('returns undefined without a memory thread (nothing durable to attach to)', () => {
    expect(
      buildRootLegPromptManifest({ messages: [], registeredToolNames: [], runtime: undefined })
    ).toBeUndefined();
  });
});
