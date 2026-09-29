import type { DelegationStartContext } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';

function admission(overrides: Partial<DelegationStartContext> = {}): DelegationStartContext {
  return {
    iteration: 1,
    messages: [],
    params: {},
    parentAgentId: 'root',
    parentAgentName: 'Root',
    primitiveId: 'worker',
    primitiveType: 'agent',
    prompt: 'Read evidence',
    requestContext: new RequestContext(),
    resourceId: 'owner',
    runId: 'run',
    threadId: 'root-thread',
    toolCallId: 'call',
    ...overrides,
  };
}
function capture(
  binding: ReturnType<typeof createDelegatedConversationBinding>,
  input: unknown = { prompt: 'Read evidence' }
): unknown {
  return binding.hooks?.beforeToolCall?.({
    context: { messages: [], threadId: 'root-thread', toolCallId: 'call' },
    input,
    toolName: 'agent-worker',
  });
}

describe('delegated observed input', () => {
  it('captures executing input even when the pre-model prompt contains no tool call', () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    expect(() => capture(binding)).not.toThrow();
    expect(() => binding.prepare(admission(), {})).not.toThrow();
  });
  it('rejects a duplicate capture for the same native call', () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    capture(binding);
    expect(() => capture(binding)).toThrow('already owns');
  });
  it('does not use model-authored identities when native context is missing', () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    expect(() =>
      binding.hooks?.beforeToolCall?.({
        context: {},
        input: { prompt: 'Read evidence', threadId: 'root-thread', toolCallId: 'call' },
        toolName: 'agent-worker',
      })
    ).toThrow('observed native identity');
  });
  it.each([{ primitiveId: 'other' }, { prompt: 'Different task' }])(
    'rejects mismatched admission %j',
    (changed) => {
      const binding = createDelegatedConversationBinding(async () => undefined);
      capture(binding);
      expect(() => binding.prepare(admission(changed), {})).toThrow(
        /different native agent|different native prompt/u
      );
    }
  );
  it('snapshots input before caller mutation', () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    const input = { prompt: 'Read evidence' };
    capture(binding, input);
    input.prompt = 'Changed after capture';
    expect(() => binding.prepare(admission(), {})).not.toThrow();
  });
});
