import type { LogRecord } from '@brainstrike/utils/logger';

export type LogBufferSubscriber = (records: readonly LogRecord[]) => void;

export interface LogBufferOptions {
  /**
   * Maximum size of args to store (in characters when stringified).
   * Larger args will be truncated. Set to 0 to disable.
   * Default: 1000
   */
  maxArgSize?: number;
  /**
   * Maximum number of records to keep in the buffer.
   * Default: 1000
   */
  size?: number;

  /**
   * If true, don't clone log args to reduce memory overhead.
   * Default: false (clone args for safety)
   */
  skipArgCloning?: boolean;
}

export class LogBuffer {
  private readonly maxSize: number;
  private readonly skipArgCloning: boolean;
  private readonly maxArgSize: number;

  private readonly records: LogRecord[] = [];

  private readonly subscribers = new Set<LogBufferSubscriber>();

  private paused = false;
  private skippedWhilePaused = 0;

  constructor(options?: LogBufferOptions) {
    this.maxSize = Math.max(1, options?.size ?? 1000);
    this.skipArgCloning = options?.skipArgCloning ?? false;
    this.maxArgSize = options?.maxArgSize ?? 1000;
  }

  /**
   * Pause the buffer - new records will be discarded.
   * Use this during bulk operations to reduce memory pressure.
   */
  pause(): void {
    this.paused = true;
    this.skippedWhilePaused = 0;
  }

  /**
   * Resume the buffer - new records will be stored again.
   */
  resume(): void {
    this.paused = false;
    // Optionally log how many were skipped
    if (this.skippedWhilePaused > 0) {
      this.records.push({
        args: [],
        bindings: {},
        level: 'info' as LogRecord['level'],
        message: `[LogBuffer] Resumed after skipping ${this.skippedWhilePaused} records during bulk operation`,
        timestamp: Date.now(),
      });
      if (this.records.length > this.maxSize) {
        this.records.shift();
      }
      this.notify();
    }
    this.skippedWhilePaused = 0;
  }

  /**
   * Check if the buffer is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Get the number of records skipped while paused.
   */
  getSkippedCount(): number {
    return this.skippedWhilePaused;
  }

  push(record: LogRecord): void {
    if (this.paused) {
      this.skippedWhilePaused++;
      return;
    }

    // Optionally process args to reduce memory footprint
    const processedRecord = this.processRecord(record);

    this.records.push(processedRecord);
    if (this.records.length > this.maxSize) {
      this.records.shift();
    }
    this.notify();
  }

  private processRecord(record: LogRecord): LogRecord {
    if (this.skipArgCloning) {
      // Store minimal info instead of full args
      return {
        ...record,
        args: record.args.map((arg) => this.summarizeArg(arg)),
      };
    }

    // Clone args but with size limits
    return {
      ...record,
      args: record.args.map((arg) => this.cloneWithSizeLimit(arg)),
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Summarizing diverse inputs requires branching.
  private summarizeArg(arg: unknown): unknown {
    if (arg === null || arg === undefined) {
      return arg;
    }

    if (typeof arg === 'string') {
      return arg.length > this.maxArgSize ? `${arg.slice(0, this.maxArgSize)}... [truncated]` : arg;
    }

    if (typeof arg === 'number' || typeof arg === 'boolean') {
      return arg;
    }

    if (typeof arg === 'object') {
      // For objects, only keep top-level keys with primitive values
      const summary: Record<string, unknown> = {};
      let keyCount = 0;
      const maxKeys = 10;

      for (const [key, value] of Object.entries(arg)) {
        if (keyCount >= maxKeys) {
          summary['...'] = `${Object.keys(arg).length - maxKeys} more keys`;
          break;
        }

        if (value === null || value === undefined) {
          summary[key] = value;
        } else if (typeof value === 'string') {
          summary[key] = value.length > 100 ? `${value.slice(0, 100)}...` : value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          summary[key] = value;
        } else if (Array.isArray(value)) {
          summary[key] = `[Array(${value.length})]`;
        } else if (typeof value === 'object') {
          summary[key] = '{Object}';
        } else {
          summary[key] = String(value);
        }

        keyCount++;
      }

      return summary;
    }

    return String(arg);
  }

  private cloneWithSizeLimit(arg: unknown): unknown {
    if (arg === null || arg === undefined) {
      return arg;
    }

    if (typeof arg === 'string') {
      return arg.length > this.maxArgSize ? `${arg.slice(0, this.maxArgSize)}... [truncated]` : arg;
    }

    if (typeof arg === 'number' || typeof arg === 'boolean') {
      return arg;
    }

    if (this.maxArgSize === 0) {
      // No size limit - do a full clone
      try {
        return structuredClone(arg);
      } catch {
        return String(arg);
      }
    }

    // For objects, use streaming size check with early exit
    // This avoids double serialization for objects that fit
    try {
      const result = this.cloneWithSizeCheck(arg, this.maxArgSize);
      if (result.oversized) {
        return this.summarizeArg(arg);
      }
      return result.value;
    } catch {
      return String(arg);
    }
  }

  /**
   * Clone an object while tracking size, with early exit if size limit exceeded.
   * Returns the cloned value and whether it was oversized.
   */
  private cloneWithSizeCheck(
    arg: unknown,
    maxSize: number
  ): { value: unknown; oversized: boolean } {
    const ctx = { currentSize: 0, maxSize };
    const clonedValue = this.cloneValue(arg, ctx);
    return { oversized: ctx.currentSize > maxSize, value: clonedValue };
  }

  /**
   * Recursively clone a value while tracking size.
   */
  private cloneValue(value: unknown, ctx: { currentSize: number; maxSize: number }): unknown {
    if (ctx.currentSize > ctx.maxSize) {
      return; // Early exit - we're already oversized
    }

    if (value === null || value === undefined) {
      ctx.currentSize += 4;
      return value;
    }

    const primitiveResult = this.clonePrimitive(value, ctx);
    if (primitiveResult !== undefined) {
      return primitiveResult.value;
    }

    if (Array.isArray(value)) {
      return this.cloneArray(value, ctx);
    }

    if (typeof value === 'object') {
      return this.cloneObject(value as Record<string, unknown>, ctx);
    }

    return String(value);
  }

  /**
   * Handle primitive types (string, number, boolean).
   * Returns undefined if value is not a primitive.
   */
  private clonePrimitive(
    value: unknown,
    ctx: { currentSize: number; maxSize: number }
  ): { value: unknown } | undefined {
    if (typeof value === 'string') {
      ctx.currentSize += value.length + 2;
      return { value };
    }
    if (typeof value === 'number') {
      ctx.currentSize += String(value).length;
      return { value };
    }
    if (typeof value === 'boolean') {
      ctx.currentSize += value ? 4 : 5;
      return { value };
    }
    return;
  }

  /**
   * Clone an array while tracking size.
   */
  private cloneArray(arr: unknown[], ctx: { currentSize: number; maxSize: number }): unknown[] {
    ctx.currentSize += 2; // brackets
    const clonedArray: unknown[] = [];
    for (const item of arr) {
      if (ctx.currentSize > ctx.maxSize) {
        return clonedArray;
      }
      clonedArray.push(this.cloneValue(item, ctx));
      ctx.currentSize += 1; // comma
    }
    return clonedArray;
  }

  /**
   * Clone an object while tracking size.
   */
  private cloneObject(
    obj: Record<string, unknown>,
    ctx: { currentSize: number; maxSize: number }
  ): Record<string, unknown> {
    ctx.currentSize += 2; // braces
    const clonedObj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (ctx.currentSize > ctx.maxSize) {
        return clonedObj;
      }
      ctx.currentSize += key.length + 3; // key + quotes + colon
      clonedObj[key] = this.cloneValue(val, ctx);
      ctx.currentSize += 1; // comma
    }
    return clonedObj;
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
    if (this.subscribers.size === 0) {
      return;
    }
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
