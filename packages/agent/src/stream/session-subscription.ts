import { createLogger } from '@brainstrike/utils/logger';
import type { StoredChunk } from './data-stream-codes';

const logger = createLogger('AgentDataStream');

export interface SessionLike {
  isClosed: () => boolean;
  pullEvent: (index: number) => StoredChunk | undefined;
  removeSubscription: (subscription: SessionSubscription) => void;
}

export class SessionSubscription {
  private nextIndex: number;
  private closed = false;

  constructor(
    private readonly session: SessionLike,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    startIndex: number
  ) {
    this.nextIndex = startIndex;
  }

  flushExisting(): void {
    while (!this.closed) {
      const chunk = this.session.pullEvent(this.nextIndex);
      if (!chunk) {
        break;
      }
      this.controller.enqueue(chunk.payload);
      this.nextIndex += 1;
    }
    if (this.session.isClosed()) {
      this.close();
    }
  }

  pushImmediate(event: StoredChunk): void {
    if (this.closed) {
      return;
    }
    if (event.sequence < this.nextIndex) {
      return;
    }
    if (event.sequence > this.nextIndex) {
      while (!this.closed && event.sequence > this.nextIndex) {
        const queued = this.session.pullEvent(this.nextIndex);
        if (!queued) {
          break;
        }
        this.controller.enqueue(queued.payload);
        this.nextIndex += 1;
      }
    }
    if (!this.closed) {
      this.controller.enqueue(event.payload);
      this.nextIndex = event.sequence + 1;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.controller.close();
    } catch (closeError) {
      // Controller close errors during subscription teardown are non-critical
      // but logged for debugging silent failures
      if (closeError instanceof Error) {
        logger.warn('Stream controller close failed', { error: closeError.message });
      }
    }
    this.session.removeSubscription(this);
  }

  /**
   * A ReadableStream cancel has already closed (or requested closure of) its
   * controller. Only detach bookkeeping here; calling controller.close() again
   * raises a noisy invalid-state error during normal request cancellation.
   */
  cancel(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.removeSubscription(this);
  }
}
