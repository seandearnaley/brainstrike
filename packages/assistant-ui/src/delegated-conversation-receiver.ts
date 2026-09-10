import {
  DELEGATED_CONVERSATION_DATA_NAME,
  type DelegatedConversationStreamData,
  type DelegatedRunIdentity,
} from '@brainstrike/assistant-contract';
import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  type AssistantStreamChunk,
  DataStreamDecoder,
} from 'assistant-stream';

export interface DelegatedConversationUpdate {
  readonly identity: DelegatedRunIdentity;
  readonly message: AssistantMessage;
  /** Latest observed native row, independent of the invocation's decoder lifetime. */
  readonly messageId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function readEnvelope(value: unknown): DelegatedConversationStreamData {
  if (!(isRecord(value) && isRecord(value['identity']))) {
    throw new Error('Invalid delegated conversation identity.');
  }
  const identity = value['identity'];
  if (
    !(
      ['childRuntimeRunId', 'parentRuntimeRunId', 'parentToolCallId', 'personaId'].every((key) =>
        isNonemptyString(identity[key])
      ) &&
      isNonemptyString(value['messageId']) &&
      Array.isArray(value['frames'])
    ) ||
    value['frames'].length === 0 ||
    !value['frames'].every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item['code'] === 'string' &&
        /^[a-z0-9-]+$/.test(item['code']) &&
        Object.hasOwn(item, 'value')
    )
  ) {
    throw new Error('Invalid delegated conversation envelope.');
  }
  return value as unknown as DelegatedConversationStreamData;
}

/** Ephemeral decoder state only. Native memory remains the transcript writer. */
class ChildReceiver {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly drained: Promise<void>;
  private failure: unknown;
  private hasFailure = false;
  private closed = false;
  private terminalObserved = false;
  private messageId: string;
  private readonly encoder = new TextEncoder();
  private readonly nested: DelegatedConversationTap;

  constructor(
    readonly identity: DelegatedRunIdentity,
    messageId: string,
    onUpdate: (update: DelegatedConversationUpdate) => void,
    private readonly abortSignal: AbortSignal
  ) {
    this.messageId = messageId;
    const input = new TransformStream<Uint8Array, Uint8Array>();
    this.writer = input.writable.getWriter();
    this.nested = createDelegatedConversationTap(onUpdate, abortSignal);
    this.drained = input.readable
      .pipeThrough(new DataStreamDecoder())
      .pipeThrough(this.nested)
      .pipeThrough(new AssistantMessageAccumulator())
      .pipeTo(
        new WritableStream<AssistantMessage>({
          write: (message) => {
            // Keep draining the vendor pipeline if a consumer throws. Teardown
            // must not cancel it while native tool substreams are settling.
            if (this.hasFailure) {
              return;
            }
            try {
              const snapshot: AssistantMessage =
                this.closed && !this.terminalObserved
                  ? {
                      ...message,
                      status: {
                        error: 'Parent stream ended before a delegated conversation terminal.',
                        reason: 'error',
                        type: 'incomplete',
                      },
                    }
                  : message;
              onUpdate({ identity: this.identity, message: snapshot, messageId: this.messageId });
            } catch (error) {
              this.failure = error;
              this.hasFailure = true;
            }
          },
        })
      )
      .catch((error: unknown) => {
        this.failure = error;
        this.hasFailure = true;
      });
  }

  async receive(envelope: DelegatedConversationStreamData): Promise<void> {
    if (this.closed) {
      throw new Error('Delegated conversation emitted frames after its terminal.');
    }
    if (envelope.identity.personaId !== this.identity.personaId) {
      throw new Error('Delegated conversation changed persona within one invocation.');
    }
    this.messageId = envelope.messageId;
    this.terminalObserved = envelope.frames.some((frame) => frame.code === 'd');
    for (const frame of envelope.frames) {
      if (this.abortSignal.aborted) {
        break;
      }
      await this.writer.write(
        this.encoder.encode(`${frame.code}:${JSON.stringify(frame.value)}\n`)
      );
    }
    if (this.terminalObserved) {
      await this.close();
    }
    this.throwIfFailed();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        await this.writer.close();
      } catch (error) {
        this.failure = error;
        this.hasFailure = true;
      }
    }
    await this.drained;
    await this.nested.settle();
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (this.hasFailure) {
      throw this.failure;
    }
  }
}

type DelegatedConversationTap = TransformStream<AssistantStreamChunk, AssistantStreamChunk> & {
  /** The response owner settles children even when upstream fails before flush. */
  settle: () => Promise<void>;
};

/** A response/replay owns one receiver per native invocation, not per row id. */
export function createDelegatedConversationTap(
  onUpdate: (update: DelegatedConversationUpdate) => void,
  abortSignal: AbortSignal
): DelegatedConversationTap {
  const children = new Map<string, ChildReceiver>();
  let settling: Promise<void> | undefined;
  const closeChildren = async (): Promise<void> => {
    const results = await Promise.allSettled([...children.values()].map((child) => child.close()));
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  };
  const settle = (): Promise<void> => {
    settling ??= closeChildren();
    return settling;
  };
  const stream = new TransformStream<AssistantStreamChunk, AssistantStreamChunk>({
    async flush() {
      const unfinished = [...children.values()].some((child) => !child.isClosed);
      await settle();
      if (unfinished && !abortSignal.aborted) {
        throw new Error('Parent stream ended before a delegated conversation terminal.');
      }
    },
    async transform(chunk, controller) {
      if (settling && abortSignal.aborted) {
        controller.enqueue(chunk);
        return;
      }
      if (
        chunk.type !== 'part-start' ||
        chunk.part.type !== 'data' ||
        chunk.part.name !== DELEGATED_CONVERSATION_DATA_NAME
      ) {
        controller.enqueue(chunk);
        return;
      }
      try {
        const envelope = readEnvelope(chunk.part.data);
        const { childRuntimeRunId, parentRuntimeRunId, parentToolCallId } = envelope.identity;
        const key = JSON.stringify([parentRuntimeRunId, parentToolCallId, childRuntimeRunId]);
        let child = children.get(key);
        if (!child) {
          const opening = envelope.frames[0];
          if (
            opening?.code !== 'f' ||
            !isRecord(opening.value) ||
            opening.value['messageId'] !== envelope.messageId
          ) {
            throw new Error('Delegated replay requires its matching native opening frame.');
          }
          child = new ChildReceiver(
            envelope.identity,
            envelope.messageId,
            (update) => {
              if (!abortSignal.aborted) {
                onUpdate(update);
              }
            },
            abortSignal
          );
          children.set(key, child);
        }
        await child.receive(envelope);
      } catch (error) {
        await settle();
        throw error;
      }
      // Preserve parent part indices; child data never becomes parent text.
      controller.enqueue(chunk);
    },
  });
  return Object.assign(stream, { settle });
}
