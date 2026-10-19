import { CanonicalOperationCancelledError } from '@brainstrike/canonical-ingestion/cancellation';
import type { Schema } from 'effect';
import {
  CANONICAL_CHANNEL,
  type CanonicalFrame,
  canonicalError,
  decode,
  decodeCanonicalFrame,
  MAX_CANONICAL_PENDING,
} from './canonical-utility-protocol';

interface Pending {
  readonly owner: string;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: unknown) => void;
}
/** Correlation for this private ingestion channel; cancellation is a notice, never a join. */
export class CanonicalUtilityChannel {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private failure: unknown;
  constructor(
    private readonly send: (frame: object) => void,
    private readonly limit = MAX_CANONICAL_PENDING
  ) {}
  get pendingCount(): number {
    return this.pending.size;
  }
  async call<S extends Schema.ConstraintDecoder<unknown>>(
    owner: string,
    op: string,
    payload: unknown,
    schema: S,
    signal?: AbortSignal,
    requestId: string | null = null
  ): Promise<S['Type']> {
    signal?.throwIfAborted();
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (this.pending.size >= this.limit) {
      throw new Error('Canonical utility pending request bound reached.');
    }
    const id = ++this.sequence;
    let cancelFailure: unknown;
    const cancel = (): void => {
      try {
        this.send({ channel: CANONICAL_CHANNEL, id, kind: 'cancel', owner });
      } catch (error) {
        cancelFailure = error;
      }
    };
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { owner, reject, resolve });
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          this.send(
            decodeCanonicalFrame({
              channel: CANONICAL_CHANNEL,
              id,
              kind: 'call',
              op,
              owner,
              payload,
              requestId,
            })
          );
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
      if (cancelFailure !== undefined) {
        throw cancelFailure;
      }
      signal?.throwIfAborted();
      return decode(schema)(value);
    } catch (error) {
      if (signal?.aborted && error instanceof CanonicalOperationCancelledError) {
        throw signal.reason;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  receive(input: unknown): CanonicalFrame {
    const frame = decodeCanonicalFrame(input);
    if (frame.kind !== 'result') {
      return frame;
    }
    const pending = this.pending.get(frame.id);
    if (!pending || pending.owner !== frame.owner) {
      throw new Error('Canonical utility response has an unknown request or owner.');
    }
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.value);
    } else if (frame.cancelled) {
      // Typed for the ingestion host: its owner cancelled this operation (BST-2140).
      pending.reject(
        new CanonicalOperationCancelledError(frame.error.message, {
          cause: canonicalError(frame.error),
        })
      );
    } else {
      const error = canonicalError(frame.error);
      error.name = frame.error.name;
      pending.reject(error);
    }
    return frame;
  }
  /** Only invoke after remote exit and local physical ownership have been joined. */
  fail(error: unknown): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      pending.reject(this.failure);
    }
    this.pending.clear();
  }
}
