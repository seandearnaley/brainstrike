import {
  CHILD_CONTINUATION_DATA_NAME,
  DELEGATED_CONVERSATION_DATA_NAME,
  type DelegatedConversationBaseline,
  type DelegatedConversationStreamData,
  type DelegatedRunIdentity,
  delegatedConversationBaselineSchema,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  type AssistantStreamChunk,
  DataStreamDecoder,
} from 'assistant-stream';
import { deferMessageFinishUntilFlush } from './defer-message-finish';

const logger = createLogger('DelegatedConversationReceiver');

export interface ChildContinuationIdentity {
  readonly continuationId: string;
  readonly nativeRunId: string;
  readonly threadId: string;
}
export type ChildConversationOwner =
  | {
      readonly identity: DelegatedRunIdentity;
      readonly continuation?: never;
      readonly continuationId?: string;
    }
  | { readonly identity?: never; readonly continuation: ChildContinuationIdentity };

export type DelegatedConversationUpdate = ChildConversationOwner & {
  readonly baseline?: DelegatedConversationBaseline;
  readonly message: AssistantMessage;
  /** Latest observed native row, independent of the invocation's decoder lifetime. */
  readonly messageId: string;
};

type ChildEnvelope = ChildConversationOwner & Omit<DelegatedConversationStreamData, 'identity'>;

export function childConversationOwnerKey(owner: ChildConversationOwner): string {
  return owner.continuation
    ? JSON.stringify(['continuation', owner.continuation.continuationId])
    : JSON.stringify([
        'delegation',
        owner.identity.parentRuntimeRunId,
        owner.identity.parentToolCallId,
        owner.identity.childRuntimeRunId,
        owner.continuationId,
      ]);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function readDelegatedEnvelope(value: unknown): DelegatedConversationStreamData {
  if (!(isRecord(value) && isRecord(value['identity']))) {
    throw new Error('Invalid delegated conversation identity.');
  }
  if (value['continuationId'] !== undefined && !isNonemptyString(value['continuationId'])) {
    throw new Error('Invalid delegated continuation anchor.');
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

function readContinuationEnvelope(value: unknown): ChildEnvelope {
  if (
    !(
      isRecord(value) &&
      ['continuationId', 'nativeRunId', 'threadId', 'messageId'].every((key) =>
        isNonemptyString(value[key])
      ) &&
      Array.isArray(value['frames']) &&
      value['frames'].length > 0 &&
      value['frames'].every(
        (item: unknown) =>
          isRecord(item) &&
          typeof item['code'] === 'string' &&
          /^[a-z0-9-]+$/.test(item['code']) &&
          Object.hasOwn(item, 'value')
      )
    )
  ) {
    throw new Error('Invalid child continuation envelope.');
  }
  if (Object.hasOwn(value, 'identity')) {
    throw new Error('A child continuation cannot contain a delegated identity.');
  }
  const baseline =
    value['baseline'] === undefined
      ? undefined
      : delegatedConversationBaselineSchema.parse(value['baseline']);
  if (baseline && baseline.threadId !== value['threadId']) {
    throw new Error('Child continuation history belongs to another thread.');
  }
  return {
    continuation: {
      continuationId: value['continuationId'] as string,
      nativeRunId: value['nativeRunId'] as string,
      threadId: value['threadId'] as string,
    },
    frames: value['frames'] as DelegatedConversationStreamData['frames'],
    messageId: value['messageId'] as string,
    ...(baseline ? { baseline } : {}),
  };
}

const isChildEnvelopeEntry = (item: unknown): item is Record<string, unknown> =>
  isRecord(item) &&
  (item['name'] === DELEGATED_CONVERSATION_DATA_NAME ||
    item['name'] === CHILD_CONTINUATION_DATA_NAME);

function readChildEnvelopes(chunk: AssistantStreamChunk): ChildEnvelope[] {
  const entries =
    chunk.type === 'data'
      ? chunk.data
      : chunk.type === 'part-start' && chunk.part.type === 'data'
        ? [chunk.part]
        : [];
  return entries.flatMap<ChildEnvelope>((item: unknown) => {
    if (!isChildEnvelopeEntry(item)) {
      return [];
    }
    return [
      item['name'] === DELEGATED_CONVERSATION_DATA_NAME
        ? readDelegatedEnvelope(item['data'])
        : readContinuationEnvelope(item['data']),
    ];
  });
}

/**
 * Out-of-band `data` entries own no parent part index, so an envelope routed
 * to its child receiver is consumed here (CONSUMED CHILD ENVELOPES,
 * assistant-subagents.md). Forwarding it made the parent accumulator retain
 * every child frame and publish a new parent message per frame, re-rendering
 * every parent part: 8,146 envelopes × 860 root parts in one GLM fan-out
 * (2026-09-15). A `part-start` data part owns a parent index and is forwarded.
 */
function withoutChildEnvelopes(chunk: AssistantStreamChunk): AssistantStreamChunk | undefined {
  if (chunk.type !== 'data') {
    return chunk;
  }
  const remaining = chunk.data.filter((item) => !isChildEnvelopeEntry(item));
  if (remaining.length === chunk.data.length) {
    return chunk;
  }
  return remaining.length === 0 ? undefined : { ...chunk, data: remaining };
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
  private baseline?: DelegatedConversationBaseline;
  private receivedFrames = false;
  private readonly nested: DelegatedConversationTap;

  constructor(
    readonly owner: ChildConversationOwner,
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
              onUpdate({
                ...(this.baseline ? { baseline: this.baseline } : {}),
                ...this.owner,
                message: snapshot,
                messageId: this.messageId,
              });
            } catch (error) {
              this.captureFailure(error);
            }
          },
        })
      )
      .catch((error: unknown) => {
        this.captureFailure(error);
      });
  }

  async receive(envelope: ChildEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error('Delegated conversation emitted frames after its terminal.');
    }
    if (this.owner.continuation) {
      if (
        !envelope.continuation ||
        envelope.continuation.nativeRunId !== this.owner.continuation.nativeRunId ||
        envelope.continuation.threadId !== this.owner.continuation.threadId
      ) {
        throw new Error('Child continuation changed its native conversation identity.');
      }
    } else if (
      !envelope.identity ||
      envelope.identity.personaId !== this.owner.identity.personaId ||
      envelope.continuationId !== this.owner.continuationId
    ) {
      throw new Error('Delegated conversation changed persona within one invocation.');
    }
    if (envelope.baseline !== undefined) {
      if (this.receivedFrames) {
        throw new Error('Delegated history baseline changed within one stream leg.');
      }
      this.baseline = delegatedConversationBaselineSchema.parse(envelope.baseline);
    }
    this.receivedFrames = true;
    this.messageId = envelope.messageId;
    this.terminalObserved = envelope.frames.some((frame) => frame.code === 'd');
    for (const frame of envelope.frames) {
      if (this.abortSignal.aborted) {
        break;
      }
      try {
        await this.writer.write(
          this.encoder.encode(`${frame.code}:${JSON.stringify(frame.value)}\n`)
        );
      } catch (error) {
        this.captureFailure(error);
        this.throwIfFailed();
      }
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
        this.captureFailure(error);
      }
    }
    await this.drained;
    try {
      await this.nested.settle();
    } catch (error) {
      this.captureFailure(error);
    }
    this.throwIfFailed();
  }

  private captureFailure(error: unknown): void {
    if (this.hasFailure) {
      return;
    }
    this.failure = error;
    this.hasFailure = true;
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
  /** Preserve an already propagating failure and report secondary cleanup errors. */
  settleAfterFailure: () => Promise<void>;
};

/** A response/replay owns one receiver per native invocation, not per row id. */
export function createDelegatedConversationTap(
  onUpdate: (update: DelegatedConversationUpdate) => void,
  abortSignal: AbortSignal,
  onTerminalFinishFlushed?: () => void
): DelegatedConversationTap {
  // Closed receivers reject post-terminal frames instead of silently restarting.
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
  let reportedSettlementFailure = false;
  const settleAfterFailure = async (): Promise<void> => {
    try {
      await settle();
    } catch (error) {
      if (!reportedSettlementFailure) {
        reportedSettlementFailure = true;
        logger.error('Child settlement failed after the primary stream failure', {
          code: 'assistant_child_settlement_after_failure',
          error,
        });
      }
    }
  };
  const receiveEnvelope = async (envelope: ChildEnvelope): Promise<void> => {
    const key = childConversationOwnerKey(envelope);
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
        envelope.continuation
          ? { continuation: envelope.continuation }
          : {
              identity: envelope.identity,
              ...(envelope.continuationId ? { continuationId: envelope.continuationId } : {}),
            },
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
      try {
        // Envelopes can be successive frames for the same decoder. Await each
        // write so its baseline/start is committed before deltas and finish.
        for (const envelope of readChildEnvelopes(chunk)) {
          await receiveEnvelope(envelope);
        }
      } catch (error) {
        await settleAfterFailure();
        throw error;
      }
      // Routed out-of-band envelopes are consumed; a part-start keeps its parent index.
      const forwarded = withoutChildEnvelopes(chunk);
      if (forwarded) {
        controller.enqueue(forwarded);
      }
    },
  });
  return {
    readable: stream.readable.pipeThrough(deferMessageFinishUntilFlush(onTerminalFinishFlushed)),
    settle,
    settleAfterFailure,
    writable: stream.writable,
  };
}
