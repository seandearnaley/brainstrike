import type { LogRecord } from './logger';

export type LogBufferSubscriber = (records: readonly LogRecord[]) => void;

export type LogBufferOptions = {
  size?: number;
};

export class LogBuffer {
  private readonly maxSize: number;

  private readonly records: LogRecord[] = [];

  private readonly subscribers = new Set<LogBufferSubscriber>();

  constructor(options?: LogBufferOptions) {
    this.maxSize = Math.max(1, options?.size ?? 1000);
  }

  push(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxSize) {
      this.records.shift();
    }
    this.notify();
  }

  clear(): void {
    this.records.length = 0;
    this.notify();
  }

  getRecords(): readonly LogRecord[] {
    return [...this.records];
  }

  subscribe(subscriber: LogBufferSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getRecords());
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private notify(): void {
    const snapshot = this.getRecords();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(snapshot);
      } catch {
        // Ignore subscriber failures
      }
    }
  }
}
