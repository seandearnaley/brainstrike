import { type DelegationStartContext, MessageList } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { createDelegatedTurnPersistence } from '../mastra/delegated-turn-persistence';

function fixture(readOnly = false) {
  const owner = new AbortController();
  const requestContext = new RequestContext();
  requestContext.set('MastraMemory', {
    memoryConfig: { readOnly },
    resourceId: 'resource',
    thread: { id: 'child' },
  });
  const context: DelegationStartContext = {
    iteration: 1,
    messages: [],
    params: {},
    parentAgentId: 'parent',
    parentAgentName: 'Parent',
    primitiveId: 'explore',
    primitiveType: 'agent',
    prompt: 'Read',
    requestContext,
    runId: 'parent-run',
    toolCallId: 'delegation-call',
  };
  const saveMessages = vi.fn(async () => ({ messages: [] }));
  const memory = {
    getThreadById: async () => ({ id: 'child' }),
    saveMessages,
  } as unknown as MastraMemory;
  const persistence = createDelegatedTurnPersistence(memory, {
    resourceId: 'owner',
    threadId: 'root',
  });
  if (!persistence) {
    throw new Error('Fixture requires memory');
  }
  const hooks = persistence.hooks(owner.signal);
  const messageList = new MessageList();
  messageList.add(
    {
      content: { format: 2, parts: [{ text: 'Visible child evidence', type: 'text' }] },
      createdAt: new Date(),
      id: 'native-message',
      resourceId: 'resource',
      role: 'assistant',
      threadId: 'child',
    },
    'response'
  );
  const attach = () =>
    persistence.processor.processInputStep?.({
      messageId: 'native-message',
      messageList,
      requestContext,
    } as ProcessInputStepArgs);
  const complete = (error?: Error) =>
    hooks.afterToolCall?.({
      context: { toolCallId: context.toolCallId },
      input: {},
      toolName: 'agent-explore',
      ...(error ? { error } : { output: {} }),
    });
  return { attach, complete, context, owner, persistence, saveMessages };
}

describe('native delegated turn persistence ownership', () => {
  it('omits the capability without memory', () => {
    expect(createDelegatedTurnPersistence(undefined, undefined)).toBeUndefined();
  });

  it('joins errors before input processing and releases the abort listener', async () => {
    const { complete, context, owner, persistence, saveMessages } = fixture();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    persistence.prepare(context, owner.signal);
    owner.abort();
    const finalization = persistence.finalize();
    await complete(new Error('Child instructions failed before execution'));
    await finalization;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('prunes settled native invocations so a later attempt can reuse the identity', async () => {
    const { complete, context, owner, persistence, saveMessages } = fixture();
    persistence.prepare(context, owner.signal);
    expect(() => persistence.prepare(context, owner.signal)).toThrow('already owns');
    await complete();
    persistence.prepare(context, owner.signal);
    await complete();
    owner.abort();
    await persistence.finalize();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('keeps read-only child memory write-free on cancellation', async () => {
    const { attach, complete, context, owner, persistence, saveMessages } = fixture(true);
    persistence.prepare(context, owner.signal);
    await attach();
    owner.abort();
    await complete();
    await persistence.finalize();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('joins and persists only the selected child while its sibling and parent remain active', async () => {
    const { attach, complete, context, owner, persistence, saveMessages } = fixture();
    const selected = new AbortController();
    persistence.prepare(context, owner.signal, selected.signal);
    await attach();
    const sibling = {
      ...context,
      requestContext: new RequestContext(),
      toolCallId: 'sibling-call',
    };
    persistence.prepare(sibling, owner.signal);
    selected.abort();
    let joined = false;
    const cancellation = persistence
      .finalize([{ parentRuntimeRunId: context.runId, parentToolCallId: context.toolCallId }])
      .then(() => {
        joined = true;
      });
    expect(joined).toBe(false);
    expect(saveMessages).not.toHaveBeenCalled();
    await complete();
    await cancellation;
    expect(joined).toBe(true);
    expect(saveMessages).toHaveBeenCalledTimes(1);
    expect(owner.signal.aborted).toBe(false);
    await persistence.hooks(owner.signal).afterToolCall?.({
      context: { toolCallId: sibling.toolCallId },
      input: {},
      output: {},
      toolName: 'agent-explore',
    });
    await persistence.finalize();
    expect(saveMessages).toHaveBeenCalledTimes(1);
  });

  it('reports failed child saves after joining native execution and releases ownership', async () => {
    const { attach, complete, context, owner, persistence, saveMessages } = fixture();
    saveMessages.mockRejectedValueOnce(new Error('Child snapshot storage failed'));
    persistence.prepare(context, owner.signal);
    await attach();
    owner.abort();
    await complete();
    await expect(persistence.finalize()).rejects.toThrow('Child snapshot storage failed');
    await persistence.finalize();
    expect(saveMessages).toHaveBeenCalledTimes(1);
  });
});
