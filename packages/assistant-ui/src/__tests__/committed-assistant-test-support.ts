import {
  fromThreadMessageLike,
  type ThreadAssistantMessage,
  type ThreadMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessageAccumulator, DataStreamDecoder } from 'assistant-stream';
import type {
  CommittedAssistantSnapshot,
  CommittedAssistantStore,
} from '../committed-assistant-store';
import recordedContinuation from './fixtures/child-continuation-native-wire.json';

/** Publication double only: neither folds a log nor implements a host command. */
export class PublishedConversation implements CommittedAssistantStore {
  private snapshot: CommittedAssistantSnapshot;
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly threadId: string,
    messages: readonly ThreadMessage[]
  ) {
    this.snapshot = {
      connection: 'connected',
      isLoading: false,
      isRunning: false,
      repository: {
        headId: messages.at(-1)?.id ?? null,
        messages: messages.map((message, index) => ({
          message,
          parentId: messages[index - 1]?.id ?? null,
        })),
      },
    };
  }
  readonly getSnapshot = (): CommittedAssistantSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish(change: Partial<CommittedAssistantSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }
  replaceMessage(message: ThreadMessage): void {
    this.publish({
      repository: {
        ...this.snapshot.repository,
        messages: this.snapshot.repository.messages.map((row) =>
          row.message.id === message.id ? { ...row, message } : row
        ),
      },
    });
  }
}

/** Actual production desktop memory/Mastra/mapper capture already committed in this package. */
export async function recordedMessage(): Promise<ThreadAssistantMessage> {
  const response = new Response(recordedContinuation.lines.join(''));
  if (!response.body) {
    throw new Error('Missing recorded response body.');
  }
  let result: ThreadAssistantMessage | undefined;
  for await (const snapshot of response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator())) {
    const message = fromThreadMessageLike(
      {
        content: snapshot.parts,
        createdAt: new Date('2026-09-12T10:51:09.660Z'),
        id: 'parent-outcome-message',
        metadata: snapshot.metadata,
        role: 'assistant',
        status: snapshot.status,
      },
      'parent-outcome-message',
      snapshot.status
    );
    if (message.role === 'assistant') {
      result = message;
    }
  }
  if (!result) {
    throw new Error('Missing recorded assistant message.');
  }
  return result;
}

/** Controlled view changes exercise adapter semantics, not claimed host/replay acceptance. */
export function viewMessage(
  id: string,
  content: ThreadMessageLike['content'],
  role: ThreadMessageLike['role'] = 'assistant'
): ThreadMessage {
  return fromThreadMessageLike({ content, createdAt: new Date(0), id, role }, id, {
    reason: 'stop',
    type: 'complete',
  });
}
