import type { DiagnosticEvent } from './diagnostic-events';

export interface DiagnosticEventSink {
  insertBatch(events: readonly DiagnosticEvent[]): Promise<void>;
}

export interface DiagnosticEventWriterOptions {
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly flushBatchSize?: number;
  readonly flushIntervalMs?: number;
  readonly makeDroppedEvent: (droppedCount: number) => DiagnosticEvent;
  readonly maxConsecutiveFailures?: number;
  readonly maxPending?: number;
  readonly onDisabled?: (cause: unknown) => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly sink: DiagnosticEventSink;
}

export class DiagnosticEventWriter {
  private readonly options: Required<
    Pick<
      DiagnosticEventWriterOptions,
      'flushBatchSize' | 'flushIntervalMs' | 'maxConsecutiveFailures' | 'maxPending'
    >
  > &
    DiagnosticEventWriterOptions;
  private pending: DiagnosticEvent[] = [];
  private droppedCount = 0;
  private consecutiveFailures = 0;
  private isDisabled = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DiagnosticEventWriterOptions) {
    this.options = {
      flushBatchSize: 32,
      flushIntervalMs: 2000,
      maxConsecutiveFailures: 5,
      maxPending: 256,
      ...options,
    };
    const schedule = this.options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.timer = schedule(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  get disabled(): boolean {
    return this.isDisabled;
  }

  enqueue(event: DiagnosticEvent): void {
    if (this.isDisabled) {
      return;
    }
    this.pending.push(event);
    while (this.pending.length > this.options.maxPending) {
      this.pending.shift();
      this.droppedCount += 1;
    }
    if (this.pending.length >= this.options.flushBatchSize) {
      void this.flush();
    }
  }

  flush(): Promise<void> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  // Drain loop ensures events enqueued during in-flight sink calls are flushed in small waves.
  private async drain(): Promise<void> {
    do {
      await this.flushInternal();
    } while (
      this.consecutiveFailures === 0 &&
      !this.isDisabled &&
      (this.pending.length > 0 || this.droppedCount > 0)
    );
  }

  private async flushInternal(): Promise<void> {
    if (this.isDisabled || (this.pending.length === 0 && this.droppedCount === 0)) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    const dropped = this.droppedCount;
    const events = dropped > 0 ? [this.options.makeDroppedEvent(dropped), ...batch] : batch;
    try {
      await this.options.sink.insertBatch(events);
      this.droppedCount -= dropped;
      this.consecutiveFailures = 0;
    } catch (cause) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
        this.isDisabled = true;
        this.pending = [];
        this.options.onDisabled?.(cause);
      } else {
        // Re-queue original batch only (not the materialized marker).
        // The counter is preserved for next attempt.
        this.pending = [...batch, ...this.pending];
        while (this.pending.length > this.options.maxPending) {
          this.pending.shift();
          this.droppedCount += 1;
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.timer !== null) {
      (this.options.clearInterval ?? globalThis.clearInterval.bind(globalThis))(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
