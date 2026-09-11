import { createHash } from 'node:crypto';
import { type Agent, createMessageSignal, signalToMastraDBMessage } from '@mastra/core/agent';
import { z } from 'zod';
import type {
  DelegatedFollowupControl,
  DelegatedFollowupInput,
  DelegatedFollowupTarget,
} from './delegated-conversation-binding';

const receiptSchema = z.object({
  runId: z.string(),
  state: z.enum(['pending', 'delivered']),
  text: z.string(),
});

async function deliver(
  child: Agent,
  target: DelegatedFollowupTarget,
  input: DelegatedFollowupInput
): Promise<void> {
  const memory = await child.getMemory();
  const store = await memory?.storage.getStore('memory');
  if (!(memory && store)) {
    throw new Error('Child follow-up requires its native durable memory.');
  }
  const id = `child-input:${createHash('sha256')
    .update(JSON.stringify([target.resourceId, target.threadId, input.id]))
    .digest('hex')}`;
  const previous = (await store.listMessagesById({ messageIds: [id] })).messages;
  if (previous.length > 0) {
    const saved = previous[0];
    const receipt = receiptSchema.parse(saved?.content.metadata?.['brainstrikeFollowup']);
    if (
      saved?.threadId !== target.threadId ||
      saved.resourceId !== target.resourceId ||
      receipt.runId !== target.runId ||
      receipt.text !== input.text
    ) {
      throw new Error('This child follow-up request already has different content or ownership.');
    }
    if (receipt.state === 'delivered') {
      return;
    }
    // A host crash can occur between native acceptance and receipt persistence.
    // Do not replay that ambiguous request into an effect-capable child.
    throw new Error(
      'Child follow-up delivery was interrupted; it will not be replayed automatically.'
    );
  }
  const running = child
    .listActiveThreadRuns()
    .some(
      (run) =>
        run.runId === target.runId &&
        run.threadId === target.threadId &&
        run.resourceId === target.resourceId
    );
  if (!running) {
    throw new Error('The selected child is no longer running; follow-up was not delivered.');
  }
  const signal = createMessageSignal(
    { contents: input.text, metadata: { brainstrikeDelegatedInput: target.identity } },
    { id }
  );
  const message = signalToMastraDBMessage(signal, target);
  const metadata = {
    ...message.content.metadata,
    brainstrikeFollowup: { runId: target.runId, state: 'pending', text: input.text },
  };
  await memory.saveMessages({
    messages: [{ ...message, content: { ...message.content, metadata } }],
  });
  const result = await child.sendSignal(signal, {
    ifIdle: { behavior: 'discard' },
    resourceId: target.resourceId,
    runId: target.runId,
    threadId: target.threadId,
  }).accepted;
  if (result.action !== 'deliver') {
    throw new Error(`The selected child did not accept the follow-up (${result.action}).`);
  }
  await store.updateMessages({
    messages: [
      {
        content: {
          ...message.content,
          metadata: {
            ...metadata,
            brainstrikeFollowup: { ...metadata.brainstrikeFollowup, state: 'delivered' },
          },
        },
        id,
      },
    ],
  });
}

/** Host authorization precedes serialized, durable input admission by this owner. */
export function createDelegatedFollowupControl(
  agents: Readonly<Record<string, Agent>>
): DelegatedFollowupControl {
  const queues = new Map<string, Promise<void>>();
  return async (target, input) => {
    const child = agents[target.personaId];
    if (!child) {
      throw new Error('The selected child has no native persona execution owner.');
    }
    const key = JSON.stringify([target.resourceId, target.threadId]);
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.then(() => deliver(child, target, input));
    // Failed input must not permanently poison later explicit requests.
    const settled = pending.then(
      () => {},
      () => {}
    );
    queues.set(key, settled);
    try {
      await pending;
    } finally {
      if (queues.get(key) === settled) {
        queues.delete(key);
      }
    }
  };
}
